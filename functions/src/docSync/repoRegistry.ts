import * as logger from "../lib/logger.js";
import { getRepoConfig, getWatchedBranches, type RepoSyncConfig } from "./configStore.js";
import type { SyncContext, DriveClient } from "./context.js";
import { createDriveClient, ensureFolderPath } from "./driveApi.js";

/**
 * Resolved configuration for a specific repo, ready for use in sync operations.
 * Combines Firestore config with runtime secrets.
 */
export interface ResolvedRepoConfig {
  repoFullName: string;
  watchedBranches: string[];
  token: string;
  sharedDriveId: string;
  rootFolderId: string;
}

/**
 * Resolves the full configuration for a repo.
 * Uses per-repo config from Firestore when available, falls back to global secrets.
 */
export async function resolveRepoConfig(
  repoFullName: string,
  globalToken: string,
  globalSharedDriveId: string,
  globalRootFolderId: string,
): Promise<ResolvedRepoConfig> {
  const config = await getRepoConfig(repoFullName);
  const watchedBranches = await getWatchedBranches(repoFullName);

  return {
    repoFullName,
    watchedBranches,
    // Per-repo overrides (future: resolve token from Secret Manager by name)
    token: globalToken,
    sharedDriveId: globalSharedDriveId,
    rootFolderId: config?.drive_root_folder_id || globalRootFolderId,
  };
}

/**
 * For multi-repo deployments, creates a repo-level subfolder under the Drive root.
 * Folder name is the repo slug (owner-repo).
 */
export async function ensureRepoFolder(
  ctx: Pick<SyncContext, "drive" | "sharedDriveId" | "dryRun">,
  rootFolderId: string,
  repoFullName: string,
): Promise<string> {
  const repoSlug = repoFullName.replace(/\//g, "-");
  return ensureFolderPath(ctx, rootFolderId, [repoSlug]);
}

/**
 * Builds a SyncContext for a specific repo + branch combination.
 * Handles multi-repo folder nesting: root / repo-slug / branch / ...
 */
export async function buildSyncContext(opts: {
  repoFullName: string;
  branch: string;
  token: string;
  sharedDriveId: string;
  rootFolderId: string;
  dryRun: boolean;
  source: SyncContext["source"];
  drive: DriveClient;
  multiRepo: boolean;
}): Promise<SyncContext> {
  const baseCtx: SyncContext = {
    repoFullName: opts.repoFullName,
    branch: opts.branch,
    sharedDriveId: opts.sharedDriveId,
    rootFolderId: opts.rootFolderId,
    token: opts.token,
    dryRun: opts.dryRun,
    source: opts.source,
    drive: opts.drive,
  };

  let folderId = opts.rootFolderId;

  // Multi-repo: add repo-level subfolder
  if (opts.multiRepo) {
    folderId = await ensureRepoFolder(baseCtx, folderId, opts.repoFullName);
  }

  // Multi-branch: add branch subfolder
  folderId = await ensureFolderPath(baseCtx, folderId, [opts.branch]);

  return { ...baseCtx, rootFolderId: folderId };
}
