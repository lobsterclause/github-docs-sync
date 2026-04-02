import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { createHash } from "node:crypto";
import type { DocSyncState, DocSyncFile } from "./types.js";
import type { SyncContext } from "./context.js";

let db: ReturnType<typeof getFirestore> | undefined;

function getDb() {
  if (!db) db = getFirestore();
  return db;
}

// ─── Key Helpers ────────────────────────────────────────────────────────────

/** Deterministic document ID from repo + branch + file path. */
export function pathToDocId(
  repoFullName: string,
  branch: string,
  filePath: string,
): string {
  return createHash("sha256")
    .update(`${repoFullName}:${branch}:${filePath}`)
    .digest("hex")
    .slice(0, 40);
}

/** Legacy document ID (path-only) for migration detection. */
export function legacyPathToDocId(filePath: string): string {
  return createHash("sha256").update(filePath).digest("hex").slice(0, 40);
}

/** Deterministic state document key from repo + branch. */
export function stateKey(repoFullName: string, branch: string): string {
  return createHash("sha256")
    .update(`${repoFullName}:${branch}`)
    .digest("hex")
    .slice(0, 40);
}

/** SHA-256 hash of file content. */
export function contentHash(content: Buffer | string): string {
  return createHash("sha256")
    .update(typeof content === "string" ? content : content)
    .digest("hex");
}

// ─── Sync State ─────────────────────────────────────────────────────────────

export async function getLastSyncState(
  ctx: Pick<SyncContext, "repoFullName" | "branch">,
): Promise<DocSyncState | null> {
  const key = stateKey(ctx.repoFullName, ctx.branch);
  const doc = await getDb().collection("doc_sync_state").doc(key).get();
  if (doc.exists) return doc.data() as DocSyncState;

  // Fallback: check legacy "global" doc for migration
  const legacy = await getDb().collection("doc_sync_state").doc("global").get();
  return legacy.exists ? (legacy.data() as DocSyncState) : null;
}

export async function updateSyncState(
  ctx: Pick<SyncContext, "repoFullName" | "branch" | "dryRun">,
  commitSha: string,
  totalFiles: number,
  tocHash?: string,
): Promise<void> {
  if (ctx.dryRun) return;

  const key = stateKey(ctx.repoFullName, ctx.branch);
  await getDb()
    .collection("doc_sync_state")
    .doc(key)
    .set(
      {
        last_commit_sha: commitSha,
        last_sync_at: FieldValue.serverTimestamp(),
        total_files_synced: totalFiles,
        repo_full_name: ctx.repoFullName,
        branch: ctx.branch,
        schema_version: 1,
        ...(tocHash !== undefined && { toc_hash: tocHash }),
      },
      { merge: true },
    );
}

// ─── File Records ───────────────────────────────────────────────────────────

export async function getFileRecord(
  ctx: Pick<SyncContext, "repoFullName" | "branch">,
  filePath: string,
): Promise<DocSyncFile | null> {
  const docId = pathToDocId(ctx.repoFullName, ctx.branch, filePath);
  const doc = await getDb().collection("doc_sync_files").doc(docId).get();
  if (doc.exists) return doc.data() as DocSyncFile;

  // Fallback: try legacy key for pre-migration records
  const legacyId = legacyPathToDocId(filePath);
  const legacy = await getDb()
    .collection("doc_sync_files")
    .doc(legacyId)
    .get();
  return legacy.exists ? (legacy.data() as DocSyncFile) : null;
}

export async function upsertFileRecord(
  ctx: Pick<SyncContext, "repoFullName" | "branch" | "dryRun">,
  record: Omit<DocSyncFile, "synced_at" | "created_at">,
): Promise<void> {
  if (ctx.dryRun) return;

  const docId = pathToDocId(ctx.repoFullName, ctx.branch, record.file_path);
  const existing = await getDb().collection("doc_sync_files").doc(docId).get();

  await getDb()
    .collection("doc_sync_files")
    .doc(docId)
    .set(
      {
        ...record,
        branch: ctx.branch,
        synced_at: FieldValue.serverTimestamp(),
        ...(existing.exists
          ? {}
          : { created_at: FieldValue.serverTimestamp() }),
      },
      { merge: true },
    );
}

export async function deleteFileRecord(
  ctx: Pick<SyncContext, "repoFullName" | "branch" | "dryRun">,
  filePath: string,
): Promise<void> {
  if (ctx.dryRun) return;

  const docId = pathToDocId(ctx.repoFullName, ctx.branch, filePath);
  await getDb().collection("doc_sync_files").doc(docId).delete();
}

export async function getAllFileRecords(
  ctx?: Pick<SyncContext, "repoFullName" | "branch">,
): Promise<DocSyncFile[]> {
  let query: FirebaseFirestore.Query = getDb().collection("doc_sync_files");

  // Scope to repo+branch when context is provided
  if (ctx) {
    query = query
      .where("source_repo", "==", ctx.repoFullName)
      .where("branch", "==", ctx.branch);
  }

  const snapshot = await query.get();
  return snapshot.docs.map((doc) => doc.data() as DocSyncFile);
}

/** Build a lookup map of file_path → DocSyncFile for O(1) link resolution. */
export async function getFileRecordsMap(
  ctx?: Pick<SyncContext, "repoFullName" | "branch">,
): Promise<Map<string, DocSyncFile>> {
  const records = await getAllFileRecords(ctx);
  const map = new Map<string, DocSyncFile>();
  for (const r of records) {
    map.set(r.file_path, r);
  }
  return map;
}

// ─── Diagram Cache ──────────────────────────────────────────────────────────

export async function getCachedDiagram(hash: string): Promise<string | null> {
  const doc = await getDb()
    .collection("doc_sync_diagram_cache")
    .doc(hash)
    .get();
  if (!doc.exists) return null;
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
