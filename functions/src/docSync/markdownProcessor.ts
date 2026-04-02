import { marked, type MarkedExtension } from "marked";
import { getOrRenderDiagram } from "./diagramCache.js";
import {
  resolveInternalLinks,
  checkBrokenLinks,
  annotateBrokenLinks,
} from "./linkResolver.js";
import { scanForSensitiveContent, shouldSkipFile } from "./contentFilter.js";
import type { DocSyncFile, CommitInfo, BrokenLink } from "./types.js";

// Register the mermaid extension globally (idempotent — marked deduplicates)
const mermaidExtension: MarkedExtension = {
  renderer: {
    code({ text, lang }: { text: string; lang?: string | null }) {
      if (lang === "mermaid") {
        // Use a unique placeholder that won't collide
        const id = `__MERMAID_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
        // Store in a WeakRef-safe way by encoding in the HTML itself
        return `<p data-mermaid-placeholder="${id}" data-mermaid-source="${encodeURIComponent(text)}">${id}</p>`;
      }
      return false;
    },
  },
};

marked.use(mermaidExtension);

/** Options for the markdown processing pipeline. */
export interface ProcessOptions {
  filePath: string;
  repoFullName: string;
  commitInfo?: CommitInfo;
  fileRecords?: Map<string, DocSyncFile>;
  allPaths?: Set<string>;
}

/** Result of processing a markdown file. */
export interface ProcessResult {
  html: string;
  skipped: boolean;
  skipReason?: string;
  brokenLinks: BrokenLink[];
  diagramsCached: number;
}

/**
 * Full markdown processing pipeline:
 * 1. Sensitive content scan
 * 2. Markdown → HTML (with mermaid placeholders)
 * 3. Resolve mermaid diagrams (with caching)
 * 4. Add metadata header
 * 5. Resolve internal links
 * 6. Check broken links
 */
export async function processMarkdown(
  rawContent: string,
  options: ProcessOptions,
): Promise<ProcessResult> {
  const brokenLinks: BrokenLink[] = [];
  let diagramsCached = 0;

  // 1. Sensitive content filter
  const sensitiveMatches = scanForSensitiveContent(
    rawContent,
    options.filePath,
  );
  if (shouldSkipFile(sensitiveMatches)) {
    const reasons = sensitiveMatches.map(
      (m) => `${m.pattern} (line ${m.line})`,
    );
    return {
      html: "",
      skipped: true,
      skipReason: `Sensitive content detected: ${reasons.join(", ")}`,
      brokenLinks: [],
      diagramsCached: 0,
    };
  }
  if (sensitiveMatches.length > 0) {
    console.warn(
      `[docSync] Warning: ${options.filePath} has ${sensitiveMatches.length} potential sensitive matches (proceeding)`,
    );
  }

  // 2. Parse markdown → HTML
  const title =
    options.filePath.split("/").pop()?.replace(/\.md$/i, "") || "Document";
  let body = marked.parse(rawContent) as string;

  // 3. Resolve mermaid diagram placeholders
  const mermaidRegex =
    /<p data-mermaid-placeholder="([^"]+)" data-mermaid-source="([^"]+)">[^<]+<\/p>/g;
  const mermaidMatches = [...body.matchAll(mermaidRegex)];

  for (const match of mermaidMatches) {
    const [fullMatch, , encodedSource] = match;
    const diagram = decodeURIComponent(encodedSource);
    const dataUri = await getOrRenderDiagram(diagram);

    if (dataUri) {
      body = body.replace(
        fullMatch,
        `<p><img src="${dataUri}" alt="Mermaid diagram" width="600" /></p>`,
      );
      diagramsCached++;
    } else {
      body = body.replace(fullMatch, `<pre><code>${diagram}</code></pre>`);
    }
  }

  // 4. Metadata header
  let header = "";
  if (options.commitInfo) {
    const ghUrl = `https://github.com/${options.repoFullName}/blob/main/${options.filePath}`;
    const date = new Date(options.commitInfo.date).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    header = `<div style="background:#f0f4f8;padding:12px 16px;border-left:4px solid #4a90d9;margin-bottom:24px;font-size:13px;color:#555;">
<strong>Source:</strong> <a href="${ghUrl}">${options.filePath}</a><br/>
<strong>Last commit:</strong> ${options.commitInfo.author} on ${date} (<code>${options.commitInfo.sha.slice(0, 7)}</code>)<br/>
<strong>Synced:</strong> ${new Date().toISOString()}
</div>`;
  }

  // 5. Resolve internal links
  if (options.fileRecords && options.fileRecords.size > 0) {
    body = resolveInternalLinks(body, options.filePath, options.fileRecords);
  }

  // 6. Broken link check
  if (options.allPaths && options.allPaths.size > 0) {
    const broken = checkBrokenLinks(body, options.filePath, options.allPaths);
    if (broken.length > 0) {
      body = annotateBrokenLinks(body, broken);
      brokenLinks.push(...broken);
    }
  }

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${title}</title></head>
<body>${header}${body}</body>
</html>`;

  return { html, skipped: false, brokenLinks, diagramsCached };
}
