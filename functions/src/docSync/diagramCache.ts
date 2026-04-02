import { createHash } from "node:crypto";
import { getCachedDiagram, cacheDiagram } from "./firestoreTracking.js";
import { MERMAID_RENDERER_BASE, MERMAID_RENDERER_URL } from "./types.js";

/**
 * Gets an ID token for calling the mermaid renderer Cloud Run service.
 */
async function getMermaidAuthToken(): Promise<string> {
  const tokenRes = await fetch(
    `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${MERMAID_RENDERER_BASE}`,
    { headers: { "Metadata-Flavor": "Google" } },
  );
  return await tokenRes.text();
}

/**
 * Renders a mermaid diagram via the Cloud Run renderer service.
 */
async function renderMermaid(diagram: string): Promise<string> {
  const idToken = await getMermaidAuthToken();

  const res = await fetch(MERMAID_RENDERER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ diagram: diagram.trim() }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Mermaid render failed (${res.status}): ${body}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  return `data:image/png;base64,${buf.toString("base64")}`;
}

/**
 * Returns a rendered diagram data URI, using the Firestore cache when possible.
 * Returns empty string on failure (caller should fall back to <pre><code>).
 */
export async function getOrRenderDiagram(diagram: string): Promise<string> {
  const trimmed = diagram.trim();
  const hash = createHash("sha256").update(trimmed).digest("hex");

  try {
    // Check cache
    const cached = await getCachedDiagram(hash);
    if (cached) {
      console.log(`[docSync] Diagram cache hit: ${hash.slice(0, 8)}`);
      return cached;
    }

    // Render and cache
    console.log(
      `[docSync] Rendering mermaid diagram (${trimmed.length} chars, hash: ${hash.slice(0, 8)})...`,
    );
    const dataUri = await renderMermaid(trimmed);
    await cacheDiagram(hash, dataUri);
    return dataUri;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[docSync] Mermaid render/cache failed: ${msg}`);
    return "";
  }
}
