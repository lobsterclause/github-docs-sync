import chalk from "chalk";
import type { SyncContext } from "github-docs-sync/docSync/context.js";
import {
  fetchRepoTree,
  fetchHeadSha,
  fetchFileFromGitHub,
  fetchFileCommitInfo,
} from "github-docs-sync/docSync/githubApi.js";
import {
  createDriveClient,
  ensureFolderPath,
  upsertFile,
} from "github-docs-sync/docSync/driveApi.js";
import { processMarkdown } from "github-docs-sync/docSync/markdownProcessor.js";
import {
  contentHash,
  getFileRecord,
  upsertFileRecord,
  updateSyncState,
  getLastSyncState,
  getFileRecordsMap,
  getAllFileRecords,
} from "github-docs-sync/docSync/firestoreTracking.js";
import {
  generateTocHtml,
  computeTocHash,
  upsertTocDoc,
} from "github-docs-sync/docSync/tocGenerator.js";
import { ensureSchemaVersion } from "github-docs-sync/docSync/migration.js";
import type { SyncResult, DryRunEntry, DryRunReport } from "github-docs-sync/docSync/types.js";

export interface SyncOptions {
  repo: string;
  branch: string;
  force: boolean;
  dryRun: boolean;
  token: string;
  sharedDriveId: string;
  rootFolderId: string;
}

export async function runSync(options: SyncOptions): Promise<void> {
  const { repo, branch, force, dryRun, token, sharedDriveId, rootFolderId } = options;

  console.log(
    chalk.blue(`Syncing ${repo}@${branch}${force ? " (force)" : ""}${dryRun ? " [DRY RUN]" : ""}`),
  );

  // Schema migration
  await ensureSchemaVersion(repo, branch);

  const drive = createDriveClient();

  // Build SyncContext
  const baseCtx: SyncContext = {
    repoFullName: repo,
    branch,
    sharedDriveId,
    rootFolderId,
    token,
    dryRun,
    source: "cli",
    drive,
  };

  // Create branch subfolder
  const branchRootFolderId = await ensureFolderPath(baseCtx, rootFolderId, [branch]);
  const ctx: SyncContext = { ...baseCtx, rootFolderId: branchRootFolderId };

  // Check if sync is needed
  const headSha = await fetchHeadSha(repo, branch, token);
  if (!force && !dryRun) {
    const state = await getLastSyncState(ctx);
    if (state && state.last_commit_sha === headSha) {
      console.log(chalk.green("Already up to date."));
      return;
    }
  }

  // Fetch all doc files
  const tree = await fetchRepoTree(repo, branch, token);
  console.log(`Found ${tree.length} doc files`);

  // Pre-load file records
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

  // Process in batches
  const BATCH_SIZE = 10;
  for (let i = 0; i < tree.length; i += BATCH_SIZE) {
    const batch = tree.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async (entry) => {
        const filePath = entry.path;
        try {
          const content = await fetchFileFromGitHub(repo, branch, filePath, token);
          if (!content) {
            results.errors++;
            return;
          }

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

          const commitInfo = await fetchFileCommitInfo(repo, branch, filePath, token);

          const processed = await processMarkdown(content.toString("utf-8"), {
            filePath,
            repoFullName: repo,
            commitInfo,
            fileRecords,
            allPaths,
            syncContext: ctx,
          });

          if (processed.skipped) {
            console.log(chalk.yellow(`  Skipped: ${filePath} (${processed.skipReason})`));
            results.skipped++;
            return;
          }

          results.cached_diagrams += processed.diagramsCached;

          if (dryRun) {
            const symbol = action === "create" ? "+" : "~";
            console.log(chalk.cyan(`  ${symbol} ${filePath}`));
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

          const targetFolderId = await ensureFolderPath(ctx, ctx.rootFolderId, folderPath);
          const driveResult = await upsertFile(ctx, targetFolderId, fileName, processed.html, {
            appProperties: {
              source_repo: repo,
              source_path: filePath,
              last_commit: commitInfo.sha.slice(0, 7),
              category,
            },
            description: `Synced from commit ${commitInfo.sha.slice(0, 7)} by ${commitInfo.author}`,
          });

          await upsertFileRecord(ctx, {
            file_path: filePath,
            drive_file_id: driveResult.driveFileId,
            drive_file_url: driveResult.driveFileUrl,
            drive_folder_id: driveResult.folderId,
            last_commit_sha: headSha,
            content_hash: hash,
            category,
            source_repo: repo,
            branch,
          });

          fileRecords.set(filePath, {
            file_path: filePath,
            drive_file_id: driveResult.driveFileId,
            drive_file_url: driveResult.driveFileUrl,
            drive_folder_id: driveResult.folderId,
            last_commit_sha: headSha,
            content_hash: hash,
            category,
            source_repo: repo,
            branch,
          });

          console.log(chalk.green(`  Synced: ${filePath}`));
          results.synced++;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(chalk.red(`  Error: ${filePath}: ${msg}`));
          results.errors++;
        }
      }),
    );

    const progress = Math.min(i + BATCH_SIZE, tree.length);
    process.stdout.write(`\r  Progress: ${progress}/${tree.length}`);
  }
  console.log(); // newline after progress

  // Update sync state
  await updateSyncState(ctx, headSha, results.synced);

  // Generate TOC
  if (!dryRun && results.synced > 0) {
    try {
      const allFiles = await getAllFileRecords(ctx);
      const tocHash = computeTocHash(allFiles);
      const html = generateTocHtml(allFiles, repo);
      await upsertTocDoc(ctx, html);
      await updateSyncState(ctx, headSha, results.synced, tocHash);
      console.log(chalk.green("  Documentation Index updated"));
    } catch (err: unknown) {
      console.error(chalk.red(`  TOC generation failed: ${err}`));
    }
  }

  // Summary
  console.log();
  console.log(chalk.bold("Results:"));
  console.log(`  Synced:  ${results.synced}`);
  console.log(`  Skipped: ${results.skipped}`);
  console.log(`  Errors:  ${results.errors}`);
  if (results.cached_diagrams > 0) {
    console.log(`  Diagram cache hits: ${results.cached_diagrams}`);
  }

  if (dryRun && wouldSync.length > 0) {
    console.log();
    console.log(chalk.bold("Would sync:"));
    for (const entry of wouldSync) {
      console.log(`  ${entry.action === "create" ? "+" : "~"} ${entry.path}`);
    }
  }
}
