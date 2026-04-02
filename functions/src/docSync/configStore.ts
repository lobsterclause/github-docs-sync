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

/**
 * Returns the list of watched branches for a repo.
 * Defaults to ["main"] if no config exists (backward compatible).
 */
export async function getWatchedBranches(
  repoFullName: string,
): Promise<string[]> {
  const doc = await getDb()
    .collection("doc_sync_config")
    .doc(repoFullName.replace(/\//g, "_"))
    .get();

  if (!doc.exists) return ["main"];

  const data = doc.data() as RepoSyncConfig;
  return data.watched_branches?.length > 0 ? data.watched_branches : ["main"];
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
    .doc(repoFullName.replace(/\//g, "_"))
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
    .doc(repoFullName.replace(/\//g, "_"))
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
    .doc(repoFullName.replace(/\//g, "_"))
    .set(config, { merge: true });
}
