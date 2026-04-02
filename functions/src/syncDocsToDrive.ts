import * as logger from "./lib/logger.js";
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  isDocFile,
  type GitHubPushEvent,
  type SyncResult,
  type DryRunEntry,
  type DryRunReport,
} from "./docSync/types.js";
import type { SyncContext } from "./docSync/context.js";
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
import { ensureSchemaVersion } from "./docSync/migration.js";
import { getWatchedBranches } from "./docSync/configStore.js";

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

/** Extract the branch name from a refs/heads/... ref string. */
function branchFromRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

/**
 * GitHub Webhook → Google Shared Drive sync for docs/ files.
 * Incrementally syncs changed docs with caching, link resolution, and content filtering.
 * Supports multi-branch sync, dry-run mode, and automatic schema migration.
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
      const repoFullName = payload.repository.full_name;
      const branch = branchFromRef(payload.ref);

      // Multi-branch: check if this branch is watched
      const watchedBranches = await getWatchedBranches(repoFullName);
      if (!watchedBranches.includes(branch)) {
        res.json({ message: `Branch ${branch} is not watched` });
        return;
      }

      const dryRun = req.headers["x-dry-run"] === "true";

      // Build SyncContext
      const ctx: SyncContext = {
        repoFullName,
        branch,
        sharedDriveId: driveSharedDriveId.value(),
        rootFolderId: driveFolderId.value(),
        token: githubToken.value(),
        dryRun,
        source: "webhook",
        drive: createDriveClient(),
      };

      // Lazy schema migration
      await ensureSchemaVersion(repoFullName, branch);

      // Multi-branch: create branch subfolder as root for this branch
      const branchRootFolderId = await ensureFolderPath(
        ctx,
        ctx.rootFolderId,
        [branch],
      );
      const branchCtx: SyncContext = { ...ctx, rootFolderId: branchRootFolderId };

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
        `Syncing ${totalChanges} doc changes on ${branch} (${added.size} added, ${modified.size} modified, ${removed.size} removed)${dryRun ? " [DRY RUN]" : ""}`,
      );

      // Pre-load file records for link resolution
      const fileRecords = await getFileRecordsMap(branchCtx);
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
      const wouldSync: DryRunEntry[] = [];
      const brokenLinksAll: Array<{ source: string; target: string }> = [];

      // Process additions and modifications
      for (const filePath of [...added, ...modified]) {
        try {
          const content = await fetchFileFromGitHub(
            repoFullName,
            branch,
            filePath,
            ctx.token,
          );
          if (!content) {
            results.errors++;
            continue;
          }

          // Incremental: skip if content unchanged
          const hash = contentHash(content);
          const existing = await getFileRecord(branchCtx, filePath);
          if (existing && existing.content_hash === hash) {
            results.skipped++;
            continue;
          }

          const action = existing ? "update" : "create";

          // Process markdown through the full pipeline
          const processed = await processMarkdown(content.toString("utf-8"), {
            filePath,
            repoFullName,
            commitInfo,
            fileRecords,
            allPaths,
            syncContext: branchCtx,
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

          if (dryRun) {
            wouldSync.push({ path: filePath, action, reason: "content changed" });
            results.synced++;
            continue;
          }

          // Upload to Drive
          const parts = filePath.split("/");
          const fileName = parts.pop()!;
          const folderPath = parts;
          const category = filePath.startsWith("docs/")
            ? filePath.split("/")[1] || "root"
            : "root";

          const targetFolderId = await ensureFolderPath(
            branchCtx,
            branchCtx.rootFolderId,
            folderPath,
          );
          const driveResult = await upsertFile(
            branchCtx,
            targetFolderId,
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
          await upsertFileRecord(branchCtx, {
            file_path: filePath,
            drive_file_id: driveResult.driveFileId,
            drive_file_url: driveResult.driveFileUrl,
            drive_folder_id: driveResult.folderId,
            last_commit_sha: payload.after,
            content_hash: hash,
            category,
            source_repo: repoFullName,
            branch,
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
          if (dryRun) {
            wouldSync.push({ path: filePath, action: "delete", reason: "file removed" });
            results.deleted++;
            continue;
          }

          const parts = filePath.split("/");
          const fileName = parts.pop()!;
          const folderPath = parts;
          const targetFolderId = await ensureFolderPath(
            branchCtx,
            branchCtx.rootFolderId,
            folderPath,
          );
          await deleteFile(branchCtx, targetFolderId, fileName);
          await deleteFileRecord(branchCtx, filePath);
          results.deleted++;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[docSync] Error deleting ${filePath}: ${msg}`);
          results.errors++;
        }
      }

      // Update sync state
      await updateSyncState(branchCtx, payload.after, results.synced);

      // Regenerate TOC if any files changed
      if (results.synced > 0 || results.deleted > 0) {
        try {
          const allFiles = await getAllFileRecords(branchCtx);
          const tocHash = computeTocHash(allFiles);
          const html = generateTocHtml(allFiles, repoFullName);
          await upsertTocDoc(branchCtx, html);
          await updateSyncState(
            branchCtx,
            payload.after,
            results.synced,
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

      logger.info(`Sync complete: ${JSON.stringify(results)}${dryRun ? " [DRY RUN]" : ""}`);

      if (dryRun) {
        const report: DryRunReport = {
          ...results,
          wouldSync,
          brokenLinks: [],
          sensitiveFiles: [],
        };
        res.json({ message: "Dry run complete", report });
      } else {
        res.json({ message: "Sync complete", results });
      }
    });
  },
);
