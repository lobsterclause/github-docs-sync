import * as logger from "./lib/logger.js";
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import type { SyncResult, DryRunEntry, DryRunReport } from "./docSync/types.js";
import type { SyncContext } from "./docSync/context.js";
import {
  fetchRepoTree,
  fetchHeadSha,
  fetchFileFromGitHub,
  fetchFileCommitInfo,
} from "./docSync/githubApi.js";
import {
  createDriveClient,
  ensureFolderPath,
  upsertFile,
} from "./docSync/driveApi.js";
import { processMarkdown } from "./docSync/markdownProcessor.js";
import {
  contentHash,
  getFileRecord,
  upsertFileRecord,
  updateSyncState,
  getLastSyncState,
  getFileRecordsMap,
  getAllFileRecords,
} from "./docSync/firestoreTracking.js";
import {
  generateTocHtml,
  computeTocHash,
  upsertTocDoc,
} from "./docSync/tocGenerator.js";
import { ensureSchemaVersion } from "./docSync/migration.js";

const githubWebhookSecret = defineSecret("GITHUB_WEBHOOK_SECRET");
const githubToken = defineSecret("GITHUB_TOKEN");
const driveSharedDriveId = defineSecret("DRIVE_SHARED_DRIVE_ID");
const driveFolderId = defineSecret("DRIVE_DOCS_FOLDER_ID");

/**
 * Full initial sync — fetches ALL doc files from the repo and syncs them to Drive.
 * Skips files whose content hasn't changed (via content hash).
 *
 * Authentication: requires the GITHUB_WEBHOOK_SECRET as an X-Webhook-Secret header.
 * Query params:
 *   ?force=true   — re-sync everything regardless of content hash
 *   ?dryRun=true  — preview what would be synced without writing
 */
export const syncDocsInitial = onRequest(
  {
    secrets: [
      githubWebhookSecret,
      githubToken,
      driveSharedDriveId,
      driveFolderId,
    ],
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async (req, res) => {
    const requestId = logger.generateRequestId();
    return logger.runWithRequestId(requestId, async () => {
      if (req.method !== "POST") {
        res.status(405).send("Method Not Allowed");
        return;
      }

      // Auth: check shared secret
      const secret = req.headers["x-webhook-secret"];
      if (secret !== githubWebhookSecret.value()) {
        res.status(401).send("Unauthorized");
        return;
      }

      const force = req.query.force === "true";
      const dryRun = req.query.dryRun === "true";
      const repoFullName = req.body?.repo as string;
      if (!repoFullName) {
        res.status(400).send("Missing required field: repo");
        return;
      }

      // Support syncing multiple branches or a single branch
      const requestedBranches: string[] = req.body?.branches
        ? (req.body.branches as string[])
        : [(req.body?.branch as string) || "main"];

      const drive = createDriveClient();
      const sharedDriveId = driveSharedDriveId.value();
      const rootFolderId = driveFolderId.value();
      const token = githubToken.value();

      const allResults: Record<string, SyncResult | DryRunReport> = {};

      for (const branch of requestedBranches) {
        logger.info(
          `Initial sync starting (force=${force}, dryRun=${dryRun}, repo=${repoFullName}, branch=${branch})`,
        );

        // Lazy schema migration
        await ensureSchemaVersion(repoFullName, branch);

        // Build SyncContext
        const baseCtx: SyncContext = {
          repoFullName,
          branch,
          sharedDriveId,
          rootFolderId,
          token,
          dryRun,
          source: "initial",
          drive,
        };

        // Multi-branch: create branch subfolder
        const branchRootFolderId = await ensureFolderPath(
          baseCtx,
          rootFolderId,
          [branch],
        );
        const ctx: SyncContext = { ...baseCtx, rootFolderId: branchRootFolderId };

        // Check if sync is needed
        const headSha = await fetchHeadSha(repoFullName, branch, token);
        if (!force && !dryRun) {
          const state = await getLastSyncState(ctx);
          if (state && state.last_commit_sha === headSha) {
            allResults[branch] = {
              synced: 0,
              skipped: 0,
              deleted: 0,
              errors: 0,
              cached_diagrams: 0,
            };
            logger.info(`Branch ${branch} already up to date`);
            continue;
          }
        }

        // Fetch all doc files from repo tree
        const tree = await fetchRepoTree(repoFullName, branch, token);
        logger.info(`Found ${tree.length} doc files in ${branch}`);

        // Pre-load file records for link resolution
        const fileRecords = await getFileRecordsMap(ctx);
        const allPaths = new Set(tree.map((t) => t.path));

        const results: SyncResult = {
          synced: 0,
          skipped: 0,
          deleted: 0,
          errors: 0,
          cached_diagrams: 0,
        };
        const wouldSync: DryRunEntry[] = [];

        // Process in batches of 10
        const BATCH_SIZE = 10;
        for (let i = 0; i < tree.length; i += BATCH_SIZE) {
          const batch = tree.slice(i, i + BATCH_SIZE);

          await Promise.all(
            batch.map(async (entry) => {
              const filePath = entry.path;
              try {
                const content = await fetchFileFromGitHub(
                  repoFullName,
                  branch,
                  filePath,
                  token,
                );
                if (!content) {
                  results.errors++;
                  return;
                }

                // Skip if content unchanged (unless force)
                const hash = contentHash(content);
                if (!force) {
                  const existing = await getFileRecord(ctx, filePath);
                  if (existing && existing.content_hash === hash) {
                    results.skipped++;
                    return;
                  }
                }

                const existingRecord = await getFileRecord(ctx, filePath);
                const action = existingRecord ? "update" as const : "create" as const;

                // Get commit info for this file
                const commitInfo = await fetchFileCommitInfo(
                  repoFullName,
                  branch,
                  filePath,
                  token,
                );

                // Process markdown
                const processed = await processMarkdown(
                  content.toString("utf-8"),
                  {
                    filePath,
                    repoFullName,
                    commitInfo,
                    fileRecords,
                    allPaths,
                    syncContext: ctx,
                  },
                );

                if (processed.skipped) {
                  console.warn(
                    `[docSync] Skipping ${filePath}: ${processed.skipReason}`,
                  );
                  results.skipped++;
                  return;
                }

                results.cached_diagrams += processed.diagramsCached;

                if (dryRun) {
                  wouldSync.push({ path: filePath, action, reason: force ? "forced" : "content changed" });
                  results.synced++;
                  return;
                }

                // Upload to Drive
                const parts = filePath.split("/");
                const fileName = parts.pop()!;
                const folderPath = parts;
                const category = filePath.startsWith("docs/")
                  ? filePath.split("/")[1] || "root"
                  : "root";

                const targetFolderId = await ensureFolderPath(
                  ctx,
                  ctx.rootFolderId,
                  folderPath,
                );
                const driveResult = await upsertFile(
                  ctx,
                  targetFolderId,
                  fileName,
                  processed.html,
                  {
                    appProperties: {
                      source_repo: repoFullName,
                      source_path: filePath,
                      last_commit: commitInfo.sha.slice(0, 7),
                      category,
                    },
                    description: `Synced from commit ${commitInfo.sha.slice(0, 7)} by ${commitInfo.author}`,
                  },
                );

                // Track in Firestore
                await upsertFileRecord(ctx, {
                  file_path: filePath,
                  drive_file_id: driveResult.driveFileId,
                  drive_file_url: driveResult.driveFileUrl,
                  drive_folder_id: driveResult.folderId,
                  last_commit_sha: headSha,
                  content_hash: hash,
                  category,
                  source_repo: repoFullName,
                  branch,
                });

                // Update the in-memory map for link resolution in subsequent files
                fileRecords.set(filePath, {
                  file_path: filePath,
                  drive_file_id: driveResult.driveFileId,
                  drive_file_url: driveResult.driveFileUrl,
                  drive_folder_id: driveResult.folderId,
                  last_commit_sha: headSha,
                  content_hash: hash,
                  category,
                  source_repo: repoFullName,
                  branch,
                } as any);

                results.synced++;
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`[docSync] Error syncing ${filePath}: ${msg}`);
                results.errors++;
              }
            }),
          );

          logger.info(
            `Batch ${Math.floor(i / BATCH_SIZE) + 1}: processed ${Math.min(i + BATCH_SIZE, tree.length)}/${tree.length} files`,
          );
        }

        // Update sync state
        await updateSyncState(ctx, headSha, results.synced);

        // Generate TOC
        if (!dryRun) {
          try {
            const allFiles = await getAllFileRecords(ctx);
            const tocHash = computeTocHash(allFiles);
            const html = generateTocHtml(allFiles, repoFullName);
            await upsertTocDoc(ctx, html);
            await updateSyncState(ctx, headSha, results.synced, tocHash);
            logger.info(`Documentation Index generated for ${branch}`);
          } catch (err: unknown) {
            console.error(`[docSync] TOC generation failed: ${err}`);
          }
        }

        logger.info(`Initial sync complete for ${branch}: ${JSON.stringify(results)}`);

        if (dryRun) {
          allResults[branch] = {
            ...results,
            wouldSync,
            brokenLinks: [],
            sensitiveFiles: [],
          } satisfies DryRunReport;
        } else {
          allResults[branch] = results;
        }
      }

      const message = dryRun ? "Dry run complete" : "Initial sync complete";
      res.json({ message, branches: requestedBranches, results: allResults });
    });
  },
);
