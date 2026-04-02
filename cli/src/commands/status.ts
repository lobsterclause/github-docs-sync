import chalk from "chalk";
import {
  getLastSyncState,
  getAllFileRecords,
} from "github-docs-sync/docSync/firestoreTracking.js";

export interface StatusOptions {
  repo: string;
  branch: string;
}

export async function runStatus(options: StatusOptions): Promise<void> {
  const { repo, branch } = options;

  console.log(chalk.blue(`Status for ${repo}@${branch}`));
  console.log();

  const state = await getLastSyncState({ repoFullName: repo, branch });

  if (!state) {
    console.log(chalk.yellow("No sync state found. Run an initial sync first."));
    return;
  }

  console.log(chalk.bold("Sync State:"));
  console.log(`  Last commit:    ${state.last_commit_sha}`);
  console.log(`  Last sync:      ${state.last_sync_at ? state.last_sync_at.toDate().toISOString() : "unknown"}`);
  console.log(`  Files synced:   ${state.total_files_synced}`);
  console.log(`  Branch:         ${state.branch || "main"}`);
  console.log(`  Schema version: ${state.schema_version || 0}`);

  const files = await getAllFileRecords({ repoFullName: repo, branch });

  if (files.length > 0) {
    console.log();
    console.log(chalk.bold(`Synced Files (${files.length}):`));

    // Group by category
    const categories = new Map<string, typeof files>();
    for (const f of files) {
      const list = categories.get(f.category) || [];
      list.push(f);
      categories.set(f.category, list);
    }

    for (const [category, categoryFiles] of [...categories.entries()].sort()) {
      console.log(`  ${chalk.cyan(category)} (${categoryFiles.length})`);
      for (const f of categoryFiles.sort((a, b) => a.file_path.localeCompare(b.file_path))) {
        const name = f.file_path.split("/").pop()?.replace(/\.md$/i, "") || f.file_path;
        console.log(`    ${name}  ${chalk.dim(f.drive_file_url)}`);
      }
    }
  }
}
