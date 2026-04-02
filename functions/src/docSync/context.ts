import type { google } from "googleapis";

export type DriveClient = ReturnType<typeof google.drive>;

/** Shared context threaded through every sync operation. */
export interface SyncContext {
  repoFullName: string;
  branch: string;
  sharedDriveId: string;
  rootFolderId: string;
  token: string;
  dryRun: boolean;
  source: "webhook" | "initial" | "cli" | "github-action";
  drive: DriveClient;
}
