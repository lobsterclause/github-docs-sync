import { createHash } from "node:crypto";
import { getFirestore } from "firebase-admin/firestore";

/** Per-repo sync configuration stored in Firestore. */
export interface RepoSyncConfig {
  watched_branches: string[];
  github_token_secret?: string;
  drive_root_folder_id?: string;
}

let db: ReturnType<typeof getFirestore> | undefined;

function getDb() {
  if (!db) db = getFirestore();
  return db;
}

/** Collision-safe document ID from a repo full name (e.g. "owner/repo"). */
function repoConfigDocId(repoFullName: string): string {
  return createHash("sha256").update(repoFullName).digest("hex").slice(0, 40);
}

/**
 * Returns the list of watched branches for a repo.
 * Defaults to [defaultBranch] if no config exists (backward compatible).
 * Falls back to ["main"] if defaultBranch is not provided.
 */
export async function getWatchedBranches(
  repoFullName: string,
  defaultBranch?: string,
): Promise<string[]> {
  const doc = await getDb()
    .collection("doc_sync_config")
    .doc(repoConfigDocId(repoFullName))
    .get();

  const fallback = [defaultBranch || "main"];
  if (!doc.exists) return fallback;

  const data = doc.data() as RepoSyncConfig;
  return data.watched_branches?.length > 0 ? data.watched_branches : fallback;
}

/**
 * Sets the watched branches for a repo.
 */
export async function setWatchedBranches(
  repoFullName: string,
  branches: string[],
): Promise<void> {
  await getDb()
    .collection("doc_sync_config")
    .doc(repoConfigDocId(repoFullName))
    .set({ watched_branches: branches }, { merge: true });
}

/**
 * Returns the full sync config for a repo, or null if none exists.
 */
export async function getRepoConfig(
  repoFullName: string,
): Promise<RepoSyncConfig | null> {
  const doc = await getDb()
    .collection("doc_sync_config")
    .doc(repoConfigDocId(repoFullName))
    .get();

  return doc.exists ? (doc.data() as RepoSyncConfig) : null;
}

/**
 * Updates sync config for a repo (merge).
 */
export async function updateRepoConfig(
  repoFullName: string,
  config: Partial<RepoSyncConfig>,
): Promise<void> {
  await getDb()
    .collection("doc_sync_config")
    .doc(repoConfigDocId(repoFullName))
    .set(config, { merge: true });
}
