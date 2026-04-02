import { createServer } from "node:http";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import puppeteer from "puppeteer";

const PORT = process.env.PORT || 8080;

// Pre-read the mermaid bundle for injection into pages
const MERMAID_JS_PATH = join(
  process.cwd(),
  "node_modules",
  "mermaid",
  "dist",
  "mermaid.min.js",
);
let mermaidJs;
try {
  mermaidJs = readFileSync(MERMAID_JS_PATH, "utf-8");
} catch {
  // Fallback: try the @mermaid-js/mermaid-cli bundled version
  mermaidJs = null;
}

let browser = null;

async function getBrowser() {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });
  }
  return browser;
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (req.method !== "POST" || req.url !== "/render") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);

  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  const { diagram, deviceScaleFactor = 3 } = body;

  if (!diagram) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing diagram field" }));
    return;
  }

  let page;
  try {
    const b = await getBrowser();
    page = await b.newPage();

    await page.setViewport({
      width: 800,
      height: 600,
      deviceScaleFactor,
    });

    // Build an HTML page that renders the mermaid diagram
    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:20px;background:white">
  <div id="container"></div>
  <script>
    ${mermaidJs || 'document.write("ERROR: mermaid.js not loaded")'}
  </script>
  <script>
    mermaid.initialize({ startOnLoad: false, theme: 'default' });
    mermaid.render('diagram', ${JSON.stringify(diagram)}).then(({ svg }) => {
      document.getElementById('container').innerHTML = svg;
      // Signal we're done
      window.__MERMAID_DONE__ = true;
    }).catch(err => {
      document.getElementById('container').innerText = 'Error: ' + err.message;
      window.__MERMAID_DONE__ = true;
      window.__MERMAID_ERROR__ = err.message;
    });
  </script>
</body>
</html>`;

    await page.setContent(html, { waitUntil: "domcontentloaded" });

    // Wait for rendering to complete
    await page.waitForFunction(() => window.__MERMAID_DONE__ === true, {
      timeout: 30000,
    });

    // Check for error
    const error = await page.evaluate(() => window.__MERMAID_ERROR__);
    if (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error }));
      return;
    }

    // Screenshot just the SVG container
    const container = await page.$("#container svg");
    if (!container) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "SVG element not found" }));
      return;
    }

    const png = await container.screenshot({
      type: "png",
      omitBackground: false,
    });

    res.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": png.length,
    });
    res.end(png);
  } catch (err) {
    console.error("Render error:", err.message);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  } finally {
    if (page) await page.close().catch(() => {});
  }
});

server.listen(PORT, () => {
  console.log(`Mermaid renderer listening on port ${PORT}`);
});
