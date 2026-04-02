import * as logger from "./lib/logger.js";
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  isDocFile,
  type GitHubPushEvent,
  type SyncResult,
} from "./docSync/types.js";
import { fetchFileFromGitHub } from "./docSync/githubApi.js";
import {
  createDriveClient,
  ensureFolderPath,
  upsertFile,
  deleteFile,
} from "./docSync/driveApi.js";
import { processMarkdown } from "./docSync/markdownProcessor.js";
import {
  contentHash,
  getFileRecord,
  upsertFileRecord,
  deleteFileRecord,
  updateSyncState,
  getFileRecordsMap,
  getAllFileRecords,
} from "./docSync/firestoreTracking.js";
import {
  generateTocHtml,
  computeTocHash,
  upsertTocDoc,
} from "./docSync/tocGenerator.js";

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
 * GitHub Webhook → Google Shared Drive sync for docs/ files.
 * Incrementally syncs changed docs with caching, link resolution, and content filtering.
 */
export const syncDocsToDrive = onRequest(
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
      const signature = req.headers["x-hub-signature-256"] as
        | string
        | undefined;
      const rawBody =
        typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      if (
        !verifyGitHubSignature(rawBody, signature, githubWebhookSecret.value())
      ) {
        logger.error("Invalid GitHub webhook signature");
        res.status(401).send("Invalid signature");
        return;
      }

      // Handle ping / non-push
      const event = req.headers["x-github-event"];
      if (event === "ping") {
        res.json({ message: "pong" });
        return;
      }
      if (event !== "push") {
        res.json({ message: `Ignored event: ${event}` });
        return;
      }

      const payload: GitHubPushEvent = req.body;
      const defaultBranch = payload.repository.default_branch;
      if (payload.ref !== `refs/heads/${defaultBranch}`) {
        res.json({ message: `Ignored push to ${payload.ref}` });
        return;
      }

      // Collect doc file changes
      const added = new Set<string>();
      const modified = new Set<string>();
      const removed = new Set<string>();

      for (const commit of payload.commits) {
        for (const f of commit.added) if (isDocFile(f)) added.add(f);
        for (const f of commit.modified) if (isDocFile(f)) modified.add(f);
        for (const f of commit.removed) {
          if (isDocFile(f)) {
            removed.add(f);
            added.delete(f);
            modified.delete(f);
          }
        }
      }

      const totalChanges = added.size + modified.size + removed.size;
      if (totalChanges === 0) {
        res.json({ message: "No doc changes to sync" });
        return;
      }

      logger.info(
        `Syncing ${totalChanges} doc changes (${added.size} added, ${modified.size} modified, ${removed.size} removed)`,
      );

      const drive = createDriveClient();
      const sharedDriveId = driveSharedDriveId.value();
      const rootFolderId = driveFolderId.value();
      const repoFullName = payload.repository.full_name;
      const token = githubToken.value();

      // Pre-load file records for link resolution
      const fileRecords = await getFileRecordsMap();
      const allPaths = new Set(fileRecords.keys());

      // Build commit info from the push payload
      const lastCommit = payload.commits[payload.commits.length - 1];
      const commitInfo = lastCommit
        ? {
            sha: payload.after,
            author: lastCommit.author.name,
            date: lastCommit.timestamp,
          }
        : undefined;

      const results: SyncResult = {
        synced: 0,
        skipped: 0,
        deleted: 0,
        errors: 0,
        cached_diagrams: 0,
      };
      const brokenLinksAll: Array<{ source: string; target: string }> = [];

      // Process additions and modifications
      for (const filePath of [...added, ...modified]) {
        try {
          const content = await fetchFileFromGitHub(
            repoFullName,
            defaultBranch,
            filePath,
            token,
          );
          if (!content) {
            results.errors++;
            continue;
          }

          // Incremental: skip if content unchanged
          const hash = contentHash(content);
          const existing = await getFileRecord(filePath);
          if (existing && existing.content_hash === hash) {
            results.skipped++;
            continue;
          }

          // Process markdown through the full pipeline
          const processed = await processMarkdown(content.toString("utf-8"), {
            filePath,
            repoFullName,
            commitInfo,
            fileRecords,
            allPaths,
          });

          if (processed.skipped) {
            console.warn(
              `[docSync] Skipping ${filePath}: ${processed.skipReason}`,
            );
            results.skipped++;
            continue;
          }

          results.cached_diagrams += processed.diagramsCached;
          for (const bl of processed.brokenLinks) {
            brokenLinksAll.push({
              source: bl.sourcePath,
              target: bl.targetPath,
            });
          }

          // Upload to Drive
          const parts = filePath.split("/");
          const fileName = parts.pop()!;
          const folderPath = parts;
          const category = filePath.startsWith("docs/")
            ? filePath.split("/")[1] || "root"
            : "root";

          const targetFolderId = await ensureFolderPath(
            drive,
            rootFolderId,
            sharedDriveId,
            folderPath,
          );
          const driveResult = await upsertFile(
            drive,
            targetFolderId,
            sharedDriveId,
            fileName,
            processed.html,
            {
              appProperties: {
                source_repo: repoFullName,
                source_path: filePath,
                last_commit: payload.after.slice(0, 7),
                category,
              },
              description: commitInfo
                ? `Updated from commit ${commitInfo.sha.slice(0, 7)} by ${commitInfo.author} — ${new Date().toISOString()}`
                : undefined,
            },
          );

          // Track in Firestore
          await upsertFileRecord({
            file_path: filePath,
            drive_file_id: driveResult.driveFileId,
            drive_file_url: driveResult.driveFileUrl,
            drive_folder_id: driveResult.folderId,
            last_commit_sha: payload.after,
            content_hash: hash,
            category,
            source_repo: repoFullName,
          });

          results.synced++;
        } catch (err: unknown) {
          const msg =
            err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
          console.error(`[docSync] Error syncing ${filePath}: ${msg}`);
          results.errors++;
        }
      }

      // Process deletions
      for (const filePath of removed) {
        try {
          const parts = filePath.split("/");
          const fileName = parts.pop()!;
          const folderPath = parts;
          const targetFolderId = await ensureFolderPath(
            drive,
            rootFolderId,
            sharedDriveId,
            folderPath,
          );
          await deleteFile(drive, targetFolderId, sharedDriveId, fileName);
          await deleteFileRecord(filePath);
          results.deleted++;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[docSync] Error deleting ${filePath}: ${msg}`);
          results.errors++;
        }
      }

      // Update sync state
      await updateSyncState(payload.after, results.synced, repoFullName);

      // Regenerate TOC if any files changed
      if (results.synced > 0 || results.deleted > 0) {
        try {
          const allFiles = await getAllFileRecords();
          const tocHash = computeTocHash(allFiles);
          const html = generateTocHtml(allFiles, repoFullName);
          await upsertTocDoc(drive, rootFolderId, sharedDriveId, html);
          await updateSyncState(
            payload.after,
            results.synced,
            repoFullName,
            tocHash,
          );
        } catch (err: unknown) {
          console.error(`[docSync] TOC generation failed: ${err}`);
        }
      }

      // Log broken links summary
      if (brokenLinksAll.length > 0) {
        logger.warn(
          `Found ${brokenLinksAll.length} broken links: ${JSON.stringify(brokenLinksAll)}`,
        );
      }

      logger.info(`Sync complete: ${JSON.stringify(results)}`);
      res.json({ message: "Sync complete", results });
    });
  },
);
