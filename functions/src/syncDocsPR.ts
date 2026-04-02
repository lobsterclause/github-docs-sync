import * as logger from "./lib/logger.js";
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  isDocFile,
  type GitHubPullRequestEvent,
  type SyncResult,
} from "./docSync/types.js";
import type { SyncContext } from "./docSync/context.js";
import { fetchFileFromGitHub, fetchRepoTree } from "./docSync/githubApi.js";
import {
  createDriveClient,
  ensureFolderPath,
  upsertFile,
} from "./docSync/driveApi.js";
import { processMarkdown } from "./docSync/markdownProcessor.js";
import {
  contentHash,
  upsertFileRecord,
  getAllFileRecords,
  deleteFileRecord,
} from "./docSync/firestoreTracking.js";

const githubWebhookSecret = defineSecret("GITHUB_WEBHOOK_SECRET");
const githubToken = defineSecret("GITHUB_TOKEN");
const driveSharedDriveId = defineSecret("DRIVE_SHARED_DRIVE_ID");
const driveFolderId = defineSecret("DRIVE_DOCS_FOLDER_ID");

function verifyGitHubSignature(
  payload: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) return false;
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`,
    "utf8",
  );
  const actual = Buffer.from(signature, "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/**
 * Creates a PR comment with links to preview docs.
 */
async function postPRComment(
  repoFullName: string,
  prNumber: number,
  body: string,
  token: string,
): Promise<void> {
  const [owner, repo] = repoFullName.split("/");
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ body }),
      },
    );
    if (!res.ok) {
      logger.warn(`Failed to post PR comment: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    logger.warn(`Failed to post PR comment: ${err}`);
  }
}

/**
 * Deletes a Drive folder and all its contents.
 */
async function deleteDriveFolder(
  ctx: SyncContext,
  folderId: string,
): Promise<void> {
  try {
    await ctx.drive.files.delete({
      fileId: folderId,
      supportsAllDrives: true,
    });
    logger.info(`Deleted preview folder: ${folderId}`);
  } catch (err) {
    logger.warn(`Failed to delete preview folder: ${err}`);
  }
}

/**
 * GitHub PR Webhook → temporary Google Docs preview.
 * Creates preview docs when PRs are opened/updated, deletes them when closed.
 */
export const syncDocsPR = onRequest(
  {
    secrets: [
      githubWebhookSecret,
      githubToken,
      driveSharedDriveId,
      driveFolderId,
    ],
    timeoutSeconds: 300,
    memory: "512MiB",
  },
  async (req, res) => {
    const requestId = logger.generateRequestId();
    return logger.runWithRequestId(requestId, async () => {
      if (req.method !== "POST") {
        res.status(405).send("Method Not Allowed");
        return;
      }

      // Verify signature
      const signature = req.headers["x-hub-signature-256"] as string | undefined;
      const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      if (!verifyGitHubSignature(rawBody, signature, githubWebhookSecret.value())) {
        res.status(401).send("Invalid signature");
        return;
      }

      const event = req.headers["x-github-event"];
      if (event === "ping") {
        res.json({ message: "pong" });
        return;
      }
      if (event !== "pull_request") {
        res.json({ message: `Ignored event: ${event}` });
        return;
      }

      const payload: GitHubPullRequestEvent = req.body;
      const { action, number: prNumber, pull_request: pr, repository } = payload;
      const repoFullName = repository.full_name;
      const token = githubToken.value();
      const prBranch = `pr-${prNumber}`;

      logger.info(`PR #${prNumber} ${action} on ${repoFullName}`);

      const drive = createDriveClient();
      const ctx: SyncContext = {
        repoFullName,
        branch: prBranch,
        sharedDriveId: driveSharedDriveId.value(),
        rootFolderId: driveFolderId.value(),
        token,
        dryRun: false,
        source: "webhook",
        drive,
      };

      // Create _pr-previews/{pr-number} folder structure
      const previewRootId = await ensureFolderPath(ctx, ctx.rootFolderId, [
        "_pr-previews",
        String(prNumber),
      ]);
      const previewCtx: SyncContext = { ...ctx, rootFolderId: previewRootId };

      if (action === "closed") {
        // Clean up: delete preview folder and Firestore records
        const records = await getAllFileRecords(previewCtx);
        for (const record of records) {
          await deleteFileRecord(previewCtx, record.file_path);
        }
        await deleteDriveFolder(ctx, previewRootId);

        res.json({ message: `PR #${prNumber} closed, previews cleaned up` });
        return;
      }

      if (action !== "opened" && action !== "synchronize" && action !== "reopened") {
        res.json({ message: `Ignored PR action: ${action}` });
        return;
      }

      // Fetch doc files from the PR's head branch
      const headBranch = pr.head.ref;
      const tree = await fetchRepoTree(repoFullName, headBranch, token);
      logger.info(`Found ${tree.length} doc files in PR #${prNumber} (${headBranch})`);

      const results: SyncResult = {
        synced: 0,
        skipped: 0,
        deleted: 0,
        errors: 0,
        cached_diagrams: 0,
      };
      const previewLinks: Array<{ name: string; url: string }> = [];

      // Process all doc files from the PR branch
      for (const entry of tree) {
        const filePath = entry.path;
        try {
          const content = await fetchFileFromGitHub(repoFullName, headBranch, filePath, token);
          if (!content) {
            results.errors++;
            continue;
          }

          const processed = await processMarkdown(content.toString("utf-8"), {
            filePath,
            repoFullName,
            commitInfo: {
              sha: pr.head.sha,
              author: pr.user.login,
              date: new Date().toISOString(),
            },
          });

          if (processed.skipped) {
            results.skipped++;
            continue;
          }

          // Upload to preview folder
          const parts = filePath.split("/");
          const fileName = parts.pop()!;
          const folderPath = parts;

          const targetFolderId = await ensureFolderPath(previewCtx, previewRootId, folderPath);
          const driveResult = await upsertFile(previewCtx, targetFolderId, fileName, processed.html, {
            appProperties: {
              source_repo: repoFullName,
              source_path: filePath,
              pr_number: String(prNumber),
            },
            description: `PR #${prNumber} preview — ${pr.title}`,
          });

          const hash = contentHash(content);
          await upsertFileRecord(previewCtx, {
            file_path: filePath,
            drive_file_id: driveResult.driveFileId,
            drive_file_url: driveResult.driveFileUrl,
            drive_folder_id: driveResult.folderId,
            last_commit_sha: pr.head.sha,
            content_hash: hash,
            category: "pr-preview",
            source_repo: repoFullName,
            branch: prBranch,
          });

          previewLinks.push({
            name: fileName.replace(/\.md$/i, ""),
            url: driveResult.driveFileUrl,
          });
          results.synced++;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`Error syncing PR preview ${filePath}: ${msg}`);
          results.errors++;
        }
      }

      // Post PR comment with preview links
      if (previewLinks.length > 0) {
        const links = previewLinks
          .map((l) => `- [${l.name}](${l.url})`)
          .join("\n");
        const comment = `## 📄 Doc Preview\n\nPreview docs for this PR:\n\n${links}\n\n_Auto-generated by github-docs-sync_`;
        await postPRComment(repoFullName, prNumber, comment, token);
      }

      logger.info(`PR #${prNumber} preview sync complete: ${JSON.stringify(results)}`);
      res.json({ message: `PR #${prNumber} preview synced`, results, previews: previewLinks });
    });
  },
);
