import { getFirestore } from "firebase-admin/firestore";
import * as logger from "../lib/logger.js";
import type { DocSyncFile, DocSyncState } from "./types.js";
import { pathToDocId, stateKey, legacyPathToDocId } from "./firestoreTracking.js";

const CURRENT_SCHEMA_VERSION = 1;

/**
 * Lazy migration: detects legacy v0 schema (single-key pathToDocId, global state)
 * and re-keys everything to v1 (repo+branch-scoped keys).
 *
 * Safe to call on every sync — no-ops if already migrated.
 */
export async function ensureSchemaVersion(
  repoFullName: string,
  branch: string,
): Promise<void> {
  const db = getFirestore();

  // Check if legacy "global" state doc exists
  const legacyStateRef = db.collection("doc_sync_state").doc("global");
  const legacyState = await legacyStateRef.get();

  if (!legacyState.exists) return; // No legacy data — fresh install

  const data = legacyState.data() as DocSyncState & { schema_version?: number };
  if (data.schema_version && data.schema_version >= CURRENT_SCHEMA_VERSION) {
    // Already migrated but the global doc wasn't cleaned up — delete it now
    await legacyStateRef.delete();
    return;
  }

  logger.info(
    `Migrating Firestore schema from v0 to v${CURRENT_SCHEMA_VERSION}...`,
  );

  // Determine repo from existing state or fall back to the provided value
  const repo = data.repo_full_name || repoFullName;
  const targetBranch = branch;

  // 1. Migrate all file records: re-key from hash(path) to hash(repo:branch:path)
  const allFiles = await db.collection("doc_sync_files").get();
  const batch = db.batch();
  let count = 0;

  for (const doc of allFiles.docs) {
    const fileData = doc.data() as DocSyncFile;
    const oldId = legacyPathToDocId(fileData.file_path);
    const newId = pathToDocId(repo, targetBranch, fileData.file_path);

    // Only migrate if the doc ID matches the legacy scheme
    if (doc.id === oldId && oldId !== newId) {
      // Write to new key
      batch.set(db.collection("doc_sync_files").doc(newId), {
        ...fileData,
        branch: targetBranch,
        source_repo: fileData.source_repo || repo,
      });
      // Delete old key
      batch.delete(doc.ref);
      count++;
    }
  }

  // 2. Write new state doc keyed by repo+branch
  const newStateKey = stateKey(repo, targetBranch);
  batch.set(db.collection("doc_sync_state").doc(newStateKey), {
    last_commit_sha: data.last_commit_sha,
    last_sync_at: data.last_sync_at,
    total_files_synced: data.total_files_synced,
    toc_hash: data.toc_hash || "",
    repo_full_name: repo,
    branch: targetBranch,
    schema_version: CURRENT_SCHEMA_VERSION,
  });

  // 3. Delete legacy global state
  batch.delete(legacyStateRef);

  await batch.commit();

  logger.info(
    `Migration complete: re-keyed ${count} file records, state moved to key ${newStateKey}`,
  );
}
