import * as logger from "../lib/logger.js";
import { google } from "googleapis";
import { Readable } from "node:stream";
import type { DriveUpsertResult } from "./types.js";
import type { SyncContext, DriveClient } from "./context.js";

export type { DriveClient } from "./context.js";

/**
 * Creates a Google Auth + Drive client using Application Default Credentials.
 */
export function createDriveClient(): DriveClient {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  return google.drive({ version: "v3", auth });
}

/**
 * Gets or creates nested folder structure in Google Drive, mirroring the repo path.
 * In dry-run mode, returns the rootFolderId without creating anything.
 */
export async function ensureFolderPath(
  ctx: Pick<SyncContext, "drive" | "sharedDriveId" | "dryRun">,
  parentId: string,
  pathSegments: string[],
): Promise<string> {
  if (ctx.dryRun) {
    logger.info(`[dry-run] Would ensure folder path: ${pathSegments.join("/")}`);
    return parentId;
  }

  const { drive, sharedDriveId } = ctx;
  let currentParent = parentId;

  for (const segment of pathSegments) {
    const query = [
      `name = '${segment.replace(/'/g, "\\'")}'`,
      `'${currentParent}' in parents`,
      `mimeType = 'application/vnd.google-apps.folder'`,
      `trashed = false`,
    ].join(" and ");

    const existing = await drive.files.list({
      q: query,
      fields: "files(id, name)",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: "drive",
      driveId: sharedDriveId,
    });

    if (existing.data.files && existing.data.files.length > 0) {
      currentParent = existing.data.files[0].id!;
    } else {
      const created = await drive.files.create({
        requestBody: {
          name: segment,
          mimeType: "application/vnd.google-apps.folder",
          parents: [currentParent],
        },
        fields: "id",
        supportsAllDrives: true,
      });
      currentParent = created.data.id!;
    }
  }

  return currentParent;
}

/**
 * Uploads or updates a file as a Google Doc. Returns the Drive file ID and URL.
 * In dry-run mode, returns a synthetic result without writing.
 */
export async function upsertFile(
  ctx: Pick<SyncContext, "drive" | "sharedDriveId" | "dryRun">,
  folderId: string,
  fileName: string,
  html: string,
  opts?: {
    appProperties?: Record<string, string>;
    description?: string;
  },
): Promise<DriveUpsertResult> {
  const docName = fileName.replace(/\.md$/i, "");

  if (ctx.dryRun) {
    logger.info(`[dry-run] Would upsert: ${docName}`);
    return {
      driveFileId: "dry-run",
      driveFileUrl: `https://docs.google.com/document/d/dry-run`,
      folderId,
    };
  }

  const { drive, sharedDriveId } = ctx;

  const query = [
    `name = '${docName.replace(/'/g, "\\'")}'`,
    `'${folderId}' in parents`,
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

  let fileId: string;

  if (existing.data.files && existing.data.files.length > 0) {
    fileId = existing.data.files[0].id!;
    await drive.files.update({
      fileId,
      media,
      requestBody: {
        ...(opts?.appProperties && { appProperties: opts.appProperties }),
        ...(opts?.description && { description: opts.description }),
      },
      supportsAllDrives: true,
    });
    logger.info(`Updated: ${docName}`);
  } else {
    const created = await drive.files.create({
      requestBody: {
        name: docName,
        mimeType: "application/vnd.google-apps.document",
        parents: [folderId],
        ...(opts?.appProperties && { appProperties: opts.appProperties }),
        ...(opts?.description && { description: opts.description }),
      },
      media,
      fields: "id",
      supportsAllDrives: true,
    });
    fileId = created.data.id!;
    logger.info(`Created: ${docName}`);
  }

  return {
    driveFileId: fileId,
    driveFileUrl: `https://docs.google.com/document/d/${fileId}`,
    folderId,
  };
}

/**
 * Deletes a Google Doc by name in a given folder.
 * In dry-run mode, returns null without deleting.
 */
export async function deleteFile(
  ctx: Pick<SyncContext, "drive" | "sharedDriveId" | "dryRun">,
  folderId: string,
  fileName: string,
): Promise<string | null> {
  const docName = fileName.replace(/\.md$/i, "");

  if (ctx.dryRun) {
    logger.info(`[dry-run] Would delete: ${docName}`);
    return "dry-run";
  }

  const { drive, sharedDriveId } = ctx;

  const query = [
    `name = '${docName.replace(/'/g, "\\'")}'`,
    `'${folderId}' in parents`,
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

  if (existing.data.files && existing.data.files.length > 0) {
    const fileId = existing.data.files[0].id!;
    await drive.files.delete({
      fileId,
      supportsAllDrives: true,
    });
    logger.info(`Deleted: ${docName}`);
    return fileId;
  }
  return null;
}
