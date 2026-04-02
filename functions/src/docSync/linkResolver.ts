import { posix as path } from "node:path";
import type { DocSyncFile, BrokenLink } from "./types.js";

/**
 * Resolves internal markdown links in HTML to Google Docs URLs.
 * Links like <a href="./other-doc.md"> or <a href="../planning/plan.md">
 * are resolved relative to the current file and looked up in the file records.
 */
export function resolveInternalLinks(
  html: string,
  currentFilePath: string,
  fileRecords: Map<string, DocSyncFile>,
): string {
  const currentDir = path.dirname(currentFilePath);

  return html.replace(
    /<a\s+href="([^"]*\.md(?:#[^"]*)?)"([^>]*)>/gi,
    (fullMatch, href: string, rest: string) => {
      // Skip external URLs
      if (href.startsWith("http://") || href.startsWith("https://")) {
        return fullMatch;
      }

      // Split off anchor fragment
      const [rawPath, fragment] = href.split("#");
      const resolved = path.normalize(path.join(currentDir, rawPath));

      const record = fileRecords.get(resolved);
      if (record) {
        const url = fragment
          ? `${record.drive_file_url}#heading=${fragment}`
          : record.drive_file_url;
        return `<a href="${url}"${rest}>`;
      }

      // Target not found — leave original href for broken link checker
      return fullMatch;
    },
  );
}

/**
 * Checks for broken internal links in HTML.
 * Returns an array of broken links found.
 */
export function checkBrokenLinks(
  html: string,
  currentFilePath: string,
  allPaths: Set<string>,
): BrokenLink[] {
  const currentDir = path.dirname(currentFilePath);
  const broken: BrokenLink[] = [];

  const linkRegex = /<a\s+href="([^"]*\.md(?:#[^"]*)?)"[^>]*>([^<]*)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1];
    const linkText = match[2];

    if (href.startsWith("http://") || href.startsWith("https://")) continue;

    const [rawPath] = href.split("#");
    const resolved = path.normalize(path.join(currentDir, rawPath));

    if (!allPaths.has(resolved)) {
      broken.push({
        sourcePath: currentFilePath,
        targetPath: resolved,
        linkText,
      });
    }
  }

  return broken;
}

/**
 * Annotates broken links in HTML with a visible [broken link] marker.
 */
export function annotateBrokenLinks(
  html: string,
  brokenLinks: BrokenLink[],
): string {
  for (const bl of brokenLinks) {
    const escapedTarget = bl.targetPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(
      `(<a\\s+href="[^"]*${escapedTarget}[^"]*"[^>]*>[^<]*</a>)`,
      "gi",
    );
    html = html.replace(
      regex,
      '$1 <span style="color:red;font-size:11px;">[broken link]</span>',
    );
  }
  return html;
}
