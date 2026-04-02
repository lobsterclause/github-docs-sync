import * as logger from "../lib/logger.js";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { google } from "googleapis";
import type { DocSyncFile } from "./types.js";

type DriveClient = ReturnType<typeof google.drive>;

/**
 * Generates an HTML table of contents from all synced file records.
 */
export function generateTocHtml(files: DocSyncFile[], repoFullName?: string): string {
  // Group by category (first meaningful path segment)
  const categories = new Map<string, DocSyncFile[]>();

  for (const file of files) {
    categories.set(file.category, [
      ...(categories.get(file.category) || []),
      file,
    ]);
  }

  // Sort categories and files within each
  const sortedCategories = [...categories.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );

  const repoLabel = repoFullName || "repository";
  let body = `<h1 style="color:#2c5f2d;">Documentation Index</h1>
<p style="color:#666;font-size:14px;">Auto-generated from <strong>${repoLabel}</strong> docs.</p>
<hr/>`;

  for (const [category, categoryFiles] of sortedCategories) {
    const displayName = category.charAt(0).toUpperCase() + category.slice(1);
    body += `<h2 style="color:#2c5f2d;margin-top:24px;">${displayName}</h2><ul>`;

    const sorted = categoryFiles.sort((a, b) =>
      a.file_path.localeCompare(b.file_path),
    );

    for (const file of sorted) {
      const name =
        file.file_path.split("/").pop()?.replace(/\.md$/i, "") ||
        file.file_path;
      const syncDate = file.synced_at
        ? new Date((file.synced_at as any)._seconds * 1000).toLocaleDateString(
            "en-US",
            { month: "short", day: "numeric", year: "numeric" },
          )
        : "unknown";

      body += `<li><a href="${file.drive_file_url}">${name}</a> <span style="color:#999;font-size:12px;">— ${file.file_path} (synced ${syncDate})</span></li>`;
    }

    body += `</ul>`;
  }

  body += `<hr/><p style="color:#999;font-size:12px;">Generated at ${new Date().toISOString()}</p>`;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Documentation Index</title></head>
<body>${body}</body>
</html>`;
}

/**
 * Computes a hash of all file paths + content hashes for change detection.
 */
export function computeTocHash(files: DocSyncFile[]): string {
  const data = files
    .map((f) => `${f.file_path}:${f.content_hash}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Creates or updates the "Documentation Index" Google Doc in the Drive root.
 */
export async function upsertTocDoc(
  drive: DriveClient,
  rootFolderId: string,
  sharedDriveId: string,
  html: string,
): Promise<void> {
  const docName = "Documentation Index";

  const query = [
    `name = '${docName}'`,
    `'${rootFolderId}' in parents`,
    `mimeType = 'application/vnd.google-apps.document'`,
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

  const media = {
    mimeType: "text/html",
    body: Readable.from(Buffer.from(html, "utf-8")),
  };

  if (existing.data.files && existing.data.files.length > 0) {
    await drive.files.update({
      fileId: existing.data.files[0].id!,
      media,
      supportsAllDrives: true,
    });
    logger.info("Updated: Documentation Index");
  } else {
    await drive.files.create({
      requestBody: {
        name: docName,
        mimeType: "application/vnd.google-apps.document",
        parents: [rootFolderId],
      },
      media,
      fields: "id",
      supportsAllDrives: true,
    });
    logger.info("Created: Documentation Index");
  }
}
