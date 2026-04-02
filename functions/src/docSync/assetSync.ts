import * as logger from "../lib/logger.js";
import { createHash } from "node:crypto";
import { posix as path } from "node:path";
import { Readable } from "node:stream";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import type { AssetCacheEntry } from "./types.js";
import type { SyncContext } from "./context.js";
import { fetchFileFromGitHub } from "./githubApi.js";

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
]);

export interface AssetReference {
  originalSrc: string;
  resolvedPath: string;
  altText: string;
}

let db: ReturnType<typeof getFirestore> | undefined;
function getDb() {
  if (!db) db = getFirestore();
  return db;
}

/**
 * Extracts image references from raw markdown content.
 * Returns references to local images (skips external URLs).
 */
export function extractImageReferences(
  markdown: string,
  filePath: string,
): AssetReference[] {
  const refs: AssetReference[] = [];
  const currentDir = path.dirname(filePath);

  // Match ![alt](src) patterns
  const imgRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;

  while ((match = imgRegex.exec(markdown)) !== null) {
    const [, altText, src] = match;

    // Skip external URLs
    if (src.startsWith("http://") || src.startsWith("https://")) continue;

    // Skip data URIs
    if (src.startsWith("data:")) continue;

    // Check if it's an image file
    const ext = path.extname(src).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) continue;

    // Resolve relative path
    const resolvedPath = src.startsWith("/")
      ? src.slice(1) // repo-absolute → remove leading slash
      : path.normalize(path.join(currentDir, src));

    refs.push({ originalSrc: src, resolvedPath, altText });
  }

  return refs;
}

/**
 * Gets a cached asset from Firestore, or returns null.
 */
async function getCachedAsset(hash: string): Promise<AssetCacheEntry | null> {
  const doc = await getDb().collection("doc_sync_assets").doc(hash).get();
  return doc.exists ? (doc.data() as AssetCacheEntry) : null;
}

/**
 * Uploads an image to Google Drive in an _assets subfolder.
 * Returns the public URL for embedding in docs.
 */
async function uploadAssetToDrive(
  ctx: SyncContext,
  buffer: Buffer,
  fileName: string,
  assetFolderId: string,
): Promise<{ driveFileId: string; driveUrl: string }> {
  const { drive, sharedDriveId } = ctx;

  // Use a path-derived unique name to prevent collisions across directories
  // e.g. docs/a/logo.png and docs/b/logo.png get distinct Drive names
  const pathHash = createHash("sha256").update(fileName).digest("hex").slice(0, 8);
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  const docName = `${base}-${pathHash}${ext}`;
  const query = [
    `name = '${docName.replace(/'/g, "\\'")}'`,
    `'${assetFolderId}' in parents`,
    `trashed = false`,
  ].join(" and ");

  const existing = await drive.files.list({
    q: query,
    fields: "files(id)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "drive",
    driveId: sharedDriveId,
  });

  const mimeTypes: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
  };
  const mimeType = mimeTypes[ext.toLowerCase()] || "application/octet-stream";

  const media = { mimeType, body: Readable.from(buffer) };
  let fileId: string;

  if (existing.data.files && existing.data.files.length > 0) {
    fileId = existing.data.files[0].id!;
    await drive.files.update({ fileId, media, supportsAllDrives: true });
  } else {
    const created = await drive.files.create({
      requestBody: {
        name: docName,
        parents: [assetFolderId],
      },
      media,
      fields: "id",
      supportsAllDrives: true,
    });
    fileId = created.data.id!;
  }

  const driveUrl = `https://drive.google.com/uc?id=${fileId}&export=view`;
  return { driveFileId: fileId, driveUrl };
}

/**
 * Resolves all image references in markdown: fetches from GitHub, uploads to Drive,
 * and returns a map of original src → Drive URL for replacement.
 */
export async function resolveImages(
  refs: AssetReference[],
  ctx: SyncContext,
): Promise<Map<string, string>> {
  const replacements = new Map<string, string>();

  if (refs.length === 0 || ctx.dryRun) {
    if (ctx.dryRun && refs.length > 0) {
      logger.info(`[dry-run] Would resolve ${refs.length} image(s)`);
    }
    return replacements;
  }

  // Ensure _assets folder exists
  const { drive, sharedDriveId, rootFolderId } = ctx;
  const assetFolderQuery = [
    `name = '_assets'`,
    `'${rootFolderId}' in parents`,
    `mimeType = 'application/vnd.google-apps.folder'`,
    `trashed = false`,
  ].join(" and ");

  const existingFolder = await drive.files.list({
    q: assetFolderQuery,
    fields: "files(id)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "drive",
    driveId: sharedDriveId,
  });

  let assetFolderId: string;
  if (existingFolder.data.files && existingFolder.data.files.length > 0) {
    assetFolderId = existingFolder.data.files[0].id!;
  } else {
    const created = await drive.files.create({
      requestBody: {
        name: "_assets",
        mimeType: "application/vnd.google-apps.folder",
        parents: [rootFolderId],
      },
      fields: "id",
      supportsAllDrives: true,
    });
    assetFolderId = created.data.id!;
  }

  for (const ref of refs) {
    try {
      // Fetch image from GitHub
      const buffer = await fetchFileFromGitHub(
        ctx.repoFullName,
        ctx.branch,
        ref.resolvedPath,
        ctx.token,
      );
      if (!buffer) {
        logger.warn(`Could not fetch image: ${ref.resolvedPath}`);
        continue;
      }

      // Check asset cache
      const hash = createHash("sha256").update(buffer).digest("hex");
      const cached = await getCachedAsset(hash);
      if (cached) {
        replacements.set(ref.originalSrc, cached.drive_url);
        continue;
      }

      // Upload to Drive
      const { driveFileId, driveUrl } = await uploadAssetToDrive(
        ctx,
        buffer,
        ref.resolvedPath,
        assetFolderId,
      );

      // Cache the asset
      await getDb()
        .collection("doc_sync_assets")
        .doc(hash)
        .set({
          content_hash: hash,
          drive_file_id: driveFileId,
          drive_url: driveUrl,
          original_paths: [ref.resolvedPath],
          size_bytes: buffer.length,
          cached_at: FieldValue.serverTimestamp(),
        } satisfies Omit<AssetCacheEntry, "cached_at"> & { cached_at: any });

      replacements.set(ref.originalSrc, driveUrl);
      logger.info(`Uploaded image: ${ref.resolvedPath}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to resolve image ${ref.resolvedPath}: ${msg}`);
    }
  }

  return replacements;
}

/**
 * Replaces image src attributes in HTML with resolved Drive URLs.
 */
export function replaceImageSources(
  html: string,
  replacements: Map<string, string>,
): string {
  for (const [original, driveUrl] of replacements) {
    // Replace in <img src="..."> tags
    const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`src="${escaped}"`, "g");
    html = html.replace(regex, `src="${driveUrl}"`);
  }
  return html;
}
