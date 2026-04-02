#!/usr/bin/env node

import { Command } from "commander";
import { resolveGitHubToken, resolveFirebaseProject, initFirebase } from "./auth.js";
import { runSync } from "./commands/sync.js";
import { runStatus } from "./commands/status.js";
import {
  runConfigBranchesList,
  runConfigBranchesAdd,
  runConfigBranchesRemove,
  runConfigShow,
} from "./commands/config.js";

const program = new Command();

program
  .name("github-docs-sync")
  .description("Sync GitHub documentation to Google Shared Drive")
  .version("1.0.0");

// ─── sync ───────────────────────────────────────────────────────────────────

program
  .command("sync")
  .description("Sync docs from a GitHub repo to Google Drive")
  .requiredOption("--repo <owner/repo>", "GitHub repository (owner/repo)")
  .option("--branch <branch>", "Branch to sync", "main")
  .option("--force", "Re-sync all files regardless of content hash", false)
  .option("--dry-run", "Preview changes without writing to Drive", false)
  .option("--drive-id <id>", "Google Shared Drive ID (or DRIVE_SHARED_DRIVE_ID env)")
  .option("--folder-id <id>", "Root folder ID in Drive (or DRIVE_DOCS_FOLDER_ID env)")
  .action(async (opts) => {
    const projectId = resolveFirebaseProject();
    await initFirebase(projectId);

    const token = resolveGitHubToken();
    const sharedDriveId = opts.driveId || process.env.DRIVE_SHARED_DRIVE_ID;
    const rootFolderId = opts.folderId || process.env.DRIVE_DOCS_FOLDER_ID;

    if (!sharedDriveId || !rootFolderId) {
      console.error(
        "Missing Drive IDs. Pass --drive-id and --folder-id, or set DRIVE_SHARED_DRIVE_ID and DRIVE_DOCS_FOLDER_ID env vars.",
      );
      process.exit(1);
    }

    await runSync({
      repo: opts.repo,
      branch: opts.branch,
      force: opts.force,
      dryRun: opts.dryRun,
      token,
      sharedDriveId,
      rootFolderId,
    });
  });

// ─── status ─────────────────────────────────────────────────────────────────

program
  .command("status")
  .description("Show sync status for a repository")
  .requiredOption("--repo <owner/repo>", "GitHub repository (owner/repo)")
  .option("--branch <branch>", "Branch to check", "main")
  .action(async (opts) => {
    const projectId = resolveFirebaseProject();
    await initFirebase(projectId);

    await runStatus({ repo: opts.repo, branch: opts.branch });
  });

// ─── config ─────────────────────────────────────────────────────────────────

const configCmd = program
  .command("config")
  .description("Manage sync configuration");

const branchesCmd = configCmd
  .command("branches")
  .description("Manage watched branches");

branchesCmd
  .command("list")
  .description("List watched branches")
  .requiredOption("--repo <owner/repo>", "GitHub repository")
  .action(async (opts) => {
    const projectId = resolveFirebaseProject();
    await initFirebase(projectId);
    await runConfigBranchesList({ repo: opts.repo });
  });

branchesCmd
  .command("add <branch>")
  .description("Add a branch to the watch list")
  .requiredOption("--repo <owner/repo>", "GitHub repository")
  .action(async (branch, opts) => {
    const projectId = resolveFirebaseProject();
    await initFirebase(projectId);
    await runConfigBranchesAdd({ repo: opts.repo }, branch);
  });

branchesCmd
  .command("remove <branch>")
  .description("Remove a branch from the watch list")
  .requiredOption("--repo <owner/repo>", "GitHub repository")
  .action(async (branch, opts) => {
    const projectId = resolveFirebaseProject();
    await initFirebase(projectId);
    await runConfigBranchesRemove({ repo: opts.repo }, branch);
  });

configCmd
  .command("show")
  .description("Show full config for a repository")
  .requiredOption("--repo <owner/repo>", "GitHub repository")
  .action(async (opts) => {
    const projectId = resolveFirebaseProject();
    await initFirebase(projectId);
    await runConfigShow({ repo: opts.repo });
  });

program.parse();
