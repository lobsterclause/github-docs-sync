import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { createHash } from "node:crypto";
import type { DocSyncState, DocSyncFile } from "./types.js";

let db: ReturnType<typeof getFirestore> | undefined;

function getDb() {
  if (!db) db = getFirestore();
  return db;
}

/** Deterministic document ID from a file path. */
export function pathToDocId(filePath: string): string {
  return createHash("sha256").update(filePath).digest("hex").slice(0, 40);
}

/** SHA-256 hash of file content. */
export function contentHash(content: Buffer | string): string {
  return createHash("sha256")
    .update(typeof content === "string" ? content : content)
    .digest("hex");
}

// --- Sync State ---

export async function getLastSyncState(): Promise<DocSyncState | null> {
  const doc = await getDb().collection("doc_sync_state").doc("global").get();
  return doc.exists ? (doc.data() as DocSyncState) : null;
}

export async function updateSyncState(
  commitSha: string,
  totalFiles: number,
  repoFullName: string,
  tocHash?: string,
): Promise<void> {
  await getDb()
    .collection("doc_sync_state")
    .doc("global")
    .set(
      {
        last_commit_sha: commitSha,
        last_sync_at: FieldValue.serverTimestamp(),
        total_files_synced: totalFiles,
        repo_full_name: repoFullName,
        ...(tocHash !== undefined && { toc_hash: tocHash }),
      },
      { merge: true },
    );
}

// --- File Records ---

export async function getFileRecord(
  filePath: string,
): Promise<DocSyncFile | null> {
  const doc = await getDb()
    .collection("doc_sync_files")
    .doc(pathToDocId(filePath))
    .get();
  return doc.exists ? (doc.data() as DocSyncFile) : null;
}

export async function upsertFileRecord(
  record: Omit<DocSyncFile, "synced_at" | "created_at">,
): Promise<void> {
  const docId = pathToDocId(record.file_path);
  const existing = await getDb().collection("doc_sync_files").doc(docId).get();

  await getDb()
    .collection("doc_sync_files")
    .doc(docId)
    .set(
      {
        ...record,
        synced_at: FieldValue.serverTimestamp(),
        ...(existing.exists
          ? {}
          : { created_at: FieldValue.serverTimestamp() }),
      },
      { merge: true },
    );
}

export async function deleteFileRecord(filePath: string): Promise<void> {
  await getDb()
    .collection("doc_sync_files")
    .doc(pathToDocId(filePath))
    .delete();
}

export async function getAllFileRecords(): Promise<DocSyncFile[]> {
  const snapshot = await getDb().collection("doc_sync_files").get();
  return snapshot.docs.map((doc) => doc.data() as DocSyncFile);
}

/** Build a lookup map of file_path → DocSyncFile for O(1) link resolution. */
export async function getFileRecordsMap(): Promise<Map<string, DocSyncFile>> {
  const records = await getAllFileRecords();
  const map = new Map<string, DocSyncFile>();
  for (const r of records) {
    map.set(r.file_path, r);
  }
  return map;
}

// --- Diagram Cache ---

export async function getCachedDiagram(hash: string): Promise<string | null> {
  const doc = await getDb()
    .collection("doc_sync_diagram_cache")
    .doc(hash)
    .get();
  if (!doc.exists) return null;
  // Increment hit count
  await doc.ref.update({ hit_count: FieldValue.increment(1) });
  return (doc.data() as { data_uri: string }).data_uri;
}

export async function cacheDiagram(
  hash: string,
  dataUri: string,
): Promise<void> {
  await getDb().collection("doc_sync_diagram_cache").doc(hash).set({
    content_hash: hash,
    data_uri: dataUri,
    rendered_at: FieldValue.serverTimestamp(),
    hit_count: 0,
  });
}
