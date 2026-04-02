import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Resolves the GitHub token from (in priority order):
 * 1. GITHUB_TOKEN environment variable
 * 2. `gh auth token` CLI
 */
export function resolveGitHubToken(): string {
  if (process.env.GITHUB_TOKEN) {
    return process.env.GITHUB_TOKEN;
  }

  try {
    const token = execSync("gh auth token", { encoding: "utf-8" }).trim();
    if (token) return token;
  } catch {
    // gh CLI not available or not authenticated
  }

  throw new Error(
    "GitHub token not found. Set GITHUB_TOKEN env var or run `gh auth login`.",
  );
}

/**
 * Resolves the Firebase project ID from (in priority order):
 * 1. FIREBASE_PROJECT environment variable
 * 2. .firebaserc file in current or parent directories
 */
export function resolveFirebaseProject(): string {
  if (process.env.FIREBASE_PROJECT) {
    return process.env.FIREBASE_PROJECT;
  }

  // Walk up directories looking for .firebaserc
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const rcPath = resolve(dir, ".firebaserc");
    if (existsSync(rcPath)) {
      try {
        const rc = JSON.parse(readFileSync(rcPath, "utf-8"));
        if (rc.projects?.default) return rc.projects.default;
      } catch {
        // malformed .firebaserc
      }
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    "Firebase project not found. Set FIREBASE_PROJECT env var or ensure .firebaserc exists.",
  );
}

/**
 * Initialize Firebase Admin SDK for local CLI use.
 * Uses Application Default Credentials (from `gcloud auth application-default login`).
 */
export async function initFirebase(projectId: string): Promise<void> {
  const { initializeApp, applicationDefault } = await import(
    "firebase-admin/app"
  );
  initializeApp({
    credential: applicationDefault(),
    projectId,
  });
}
