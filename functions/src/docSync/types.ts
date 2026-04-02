import type { Timestamp } from "firebase-admin/firestore";

/** GitHub push webhook payload (subset of fields we use). */
export interface GitHubPushEvent {
  ref: string;
  after: string; // HEAD SHA after the push
  commits: Array<{
    id: string;
    added: string[];
    modified: string[];
    removed: string[];
    author: { name: string; email: string };
    timestamp: string;
  }>;
  repository: {
    full_name: string;
    default_branch: string;
  };
}

/** GitHub Trees API entry. */
export interface GitHubTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
}

/** Firestore: singleton at doc_sync_state/global */
export interface DocSyncState {
  last_commit_sha: string;
  last_sync_at: Timestamp;
  total_files_synced: number;
  toc_hash: string;
  repo_full_name: string;
}

/** Firestore: one doc per synced file at doc_sync_files/{pathHash} */
export interface DocSyncFile {
  file_path: string;
  drive_file_id: string;
  drive_file_url: string;
  drive_folder_id: string;
  last_commit_sha: string;
  content_hash: string;
  category: string;
  synced_at: Timestamp;
  created_at: Timestamp;
  source_repo: string;
}

/** Firestore: cached diagram at doc_sync_diagram_cache/{contentHash} */
export interface DiagramCacheEntry {
  content_hash: string;
  data_uri: string;
  rendered_at: Timestamp;
  hit_count: number;
}

/** Result of a sync operation. */
export interface SyncResult {
  synced: number;
  skipped: number;
  deleted: number;
  errors: number;
  cached_diagrams: number;
}

/** Commit metadata for headers. */
export interface CommitInfo {
  sha: string;
  author: string;
  date: string;
}

/** Result of upserting a file to Drive. */
export interface DriveUpsertResult {
  driveFileId: string;
  driveFileUrl: string;
  folderId: string;
}

/** A broken link found during sync. */
export interface BrokenLink {
  sourcePath: string;
  targetPath: string;
  linkText: string;
}

/** A sensitive content match. */
export interface SensitiveMatch {
  pattern: string;
  match: string;
  line: number;
}

// Constants
export const MERMAID_RENDERER_BASE =
  process.env.MERMAID_RENDERER_URL ||
  "http://localhost:8080";
export const MERMAID_RENDERER_URL = `${MERMAID_RENDERER_BASE}/render`;

export const DOC_FILE_PATTERNS = {
  prefixes: ["docs/"],
  exactMatches: ["CLAUDE.md", "README.md", "CONTRIBUTING.md"],
};

/** Returns true if the file path should be synced to Drive. */
export function isDocFile(path: string): boolean {
  for (const prefix of DOC_FILE_PATTERNS.prefixes) {
    if (path.startsWith(prefix)) return true;
  }
  return DOC_FILE_PATTERNS.exactMatches.includes(path);
}
