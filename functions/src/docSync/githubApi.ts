import * as logger from "../lib/logger.js";
import { isDocFile, type GitHubTreeEntry } from "./types.js";

/**
 * Fetches file content from GitHub using the Contents API.
 */
export async function fetchFileFromGitHub(
  repoFullName: string,
  branch: string,
  filePath: string,
  token: string,
): Promise<Buffer | null> {
  const url = `https://api.github.com/repos/${repoFullName}/contents/${filePath}?ref=${branch}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.raw+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    logger.warn(`Failed to fetch ${filePath}: ${res.status}`);
    return null;
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Fetches the full repository tree and returns all doc file paths.
 */
export async function fetchRepoTree(
  repoFullName: string,
  branch: string,
  token: string,
): Promise<GitHubTreeEntry[]> {
  const url = `https://api.github.com/repos/${repoFullName}/git/trees/${branch}?recursive=1`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch repo tree: ${res.status}`);
  }
  const data = (await res.json()) as { tree: GitHubTreeEntry[] };
  return data.tree.filter(
    (entry) => entry.type === "blob" && isDocFile(entry.path),
  );
}

/**
 * Fetches the HEAD commit SHA for a branch.
 */
export async function fetchHeadSha(
  repoFullName: string,
  branch: string,
  token: string,
): Promise<string> {
  const url = `https://api.github.com/repos/${repoFullName}/commits/${branch}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch HEAD SHA: ${res.status}`);
  }
  const data = (await res.json()) as { sha: string };
  return data.sha;
}

/**
 * Fetches commit info for a specific file (last commit that touched it).
 */
export async function fetchFileCommitInfo(
  repoFullName: string,
  branch: string,
  filePath: string,
  token: string,
): Promise<{ sha: string; author: string; date: string }> {
  const url = `https://api.github.com/repos/${repoFullName}/commits?sha=${branch}&path=${encodeURIComponent(filePath)}&per_page=1`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    return {
      sha: "unknown",
      author: "unknown",
      date: new Date().toISOString(),
    };
  }
  const commits = (await res.json()) as Array<{ sha: string; commit?: { author?: { name?: string; date?: string } } }>;
  if (commits.length === 0) {
    return {
      sha: "unknown",
      author: "unknown",
      date: new Date().toISOString(),
    };
  }
  const c = commits[0];
  return {
    sha: c.sha,
    author: c.commit?.author?.name || "unknown",
    date: c.commit?.author?.date || new Date().toISOString(),
  };
}
