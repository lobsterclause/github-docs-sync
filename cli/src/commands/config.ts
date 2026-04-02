import chalk from "chalk";
import {
  getWatchedBranches,
  setWatchedBranches,
  getRepoConfig,
} from "github-docs-sync/docSync/configStore.js";

export interface ConfigOptions {
  repo: string;
}

export async function runConfigBranchesList(options: ConfigOptions): Promise<void> {
  const branches = await getWatchedBranches(options.repo);
  console.log(chalk.bold(`Watched branches for ${options.repo}:`));
  for (const b of branches) {
    console.log(`  - ${b}`);
  }
}

export async function runConfigBranchesAdd(
  options: ConfigOptions,
  branch: string,
): Promise<void> {
  const branches = await getWatchedBranches(options.repo);
  if (branches.includes(branch)) {
    console.log(chalk.yellow(`Branch "${branch}" is already watched.`));
    return;
  }
  branches.push(branch);
  await setWatchedBranches(options.repo, branches);
  console.log(chalk.green(`Added "${branch}" to watched branches.`));
}

export async function runConfigBranchesRemove(
  options: ConfigOptions,
  branch: string,
): Promise<void> {
  const branches = await getWatchedBranches(options.repo);
  const filtered = branches.filter((b) => b !== branch);
  if (filtered.length === branches.length) {
    console.log(chalk.yellow(`Branch "${branch}" is not watched.`));
    return;
  }
  await setWatchedBranches(options.repo, filtered);
  console.log(chalk.green(`Removed "${branch}" from watched branches.`));
}

export async function runConfigShow(options: ConfigOptions): Promise<void> {
  const config = await getRepoConfig(options.repo);
  if (!config) {
    console.log(chalk.yellow(`No config found for ${options.repo}. Using defaults.`));
    console.log(`  Watched branches: ["main"]`);
    return;
  }
  console.log(chalk.bold(`Config for ${options.repo}:`));
  console.log(`  Watched branches: ${JSON.stringify(config.watched_branches || ["main"])}`);
  if (config.drive_root_folder_id) {
    console.log(`  Drive root folder: ${config.drive_root_folder_id}`);
  }
}
