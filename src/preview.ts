import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

interface PreviewOptions {
  dir: string;
  host: string;
  port: number;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function readOptional(filePath: string, fallback = "") {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return fallback;
  }
}

function previewShell(issueJson: string, text: string) {
  const issue = (() => {
    try {
      return JSON.parse(issueJson) as {
        title?: string;
        preheader?: string;
        intro?: string;
        sourceLabel?: string;
        items?: Array<{ title?: string; url?: string; summary?: string }>;
        skippedSeenCount?: number;
      };
    } catch {
      return {};
    }
  })();

  const items = issue.items ?? [];
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Feedletter Preview</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body { margin: 0; background: #0b0d10; color: #eef2f7; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      header { height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 0 24px; border-bottom: 1px solid rgba(255,255,255,.08); background: rgba(11,13,16,.92); position: sticky; top: 0; z-index: 3; }
      main { display: grid; grid-template-columns: 360px minmax(0, 1fr); min-height: calc(100vh - 64px); }
      aside { border-right: 1px solid rgba(255,255,255,.08); padding: 22px; overflow: auto; }
      .label { color: #7dd3fc; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; font-weight: 800; }
      h1 { margin: 8px 0 10px; font-size: 26px; line-height: 1.16; letter-spacing: 0; }
      p { color: #9aa4b2; line-height: 1.55; }
      .meta { display: flex; flex-wrap: wrap; gap: 8px; margin: 18px 0; }
      .pill { border: 1px solid rgba(255,255,255,.09); background: rgba(255,255,255,.045); border-radius: 999px; padding: 7px 10px; color: #cbd5e1; font-size: 12px; }
      .item { padding: 14px 0; border-top: 1px solid rgba(255,255,255,.07); }
      .item a { color: #f8fafc; text-decoration: none; font-weight: 700; }
      .item p { margin: 6px 0 0; font-size: 13px; }
      .stage { padding: 22px; overflow: auto; background: radial-gradient(circle at top left, rgba(20,184,166,.12), transparent 34%), #111318; }
      .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
      .tabs { display: flex; gap: 8px; }
      button, .link { border: 1px solid rgba(255,255,255,.1); background: rgba(255,255,255,.06); color: #e5e7eb; border-radius: 8px; padding: 9px 12px; font: inherit; font-size: 13px; cursor: pointer; text-decoration: none; }
      button.active { background: #f8fafc; color: #111827; border-color: #f8fafc; }
      iframe { width: min(100%, 760px); height: calc(100vh - 134px); border: 0; border-radius: 14px; background: white; box-shadow: 0 24px 80px rgba(0,0,0,.35); display: block; margin: 0 auto; }
      pre { display: none; margin: 0; height: calc(100vh - 134px); overflow: auto; border: 1px solid rgba(255,255,255,.08); border-radius: 14px; background: #07090c; padding: 18px; color: #dbeafe; white-space: pre-wrap; line-height: 1.5; }
      @media (max-width: 860px) {
        main { grid-template-columns: 1fr; }
        aside { border-right: 0; border-bottom: 1px solid rgba(255,255,255,.08); }
        iframe, pre { height: 70vh; }
      }
    </style>
  </head>
  <body>
    <header>
      <strong>Feedletter Preview</strong>
      <nav>
        <a class="link" href="/email.html" target="_blank">Open email</a>
        <a class="link" href="/issue.json" target="_blank">JSON</a>
      </nav>
    </header>
    <main>
      <aside>
        <div class="label">${escapeHtml(issue.sourceLabel ?? "Digest")}</div>
        <h1>${escapeHtml(issue.title ?? "Untitled issue")}</h1>
        <p>${escapeHtml(issue.intro ?? "")}</p>
        <div class="meta">
          <span class="pill">${items.length} item${items.length === 1 ? "" : "s"}</span>
          <span class="pill">${escapeHtml(issue.preheader ?? "No preheader")}</span>
          ${issue.skippedSeenCount ? `<span class="pill">${issue.skippedSeenCount} seen skipped</span>` : ""}
        </div>
        ${items
          .map(
            (item) => `<div class="item">
              ${item.url ? `<a href="${escapeHtml(item.url)}" target="_blank">${escapeHtml(item.title ?? "Untitled")}</a>` : `<strong>${escapeHtml(item.title ?? "Untitled")}</strong>`}
              ${item.summary ? `<p>${escapeHtml(item.summary)}</p>` : ""}
            </div>`,
          )
          .join("")}
      </aside>
      <section class="stage">
        <div class="toolbar">
          <div class="tabs">
            <button id="emailTab" class="active" type="button">Email</button>
            <button id="textTab" type="button">Text</button>
            <button id="jsonTab" type="button">JSON</button>
          </div>
        </div>
        <iframe id="emailPanel" src="/email.html" title="Generated email preview"></iframe>
        <pre id="textPanel">${escapeHtml(text)}</pre>
        <pre id="jsonPanel">${escapeHtml(issueJson)}</pre>
      </section>
    </main>
    <script>
      const tabs = [
        ["emailTab", "emailPanel"],
        ["textTab", "textPanel"],
        ["jsonTab", "jsonPanel"],
      ];
      for (const [tabId, panelId] of tabs) {
        document.getElementById(tabId).addEventListener("click", () => {
          for (const [otherTab, otherPanel] of tabs) {
            document.getElementById(otherTab).classList.toggle("active", otherTab === tabId);
            document.getElementById(otherPanel).style.display = otherPanel === panelId ? (otherPanel === "emailPanel" ? "block" : "block") : "none";
          }
        });
      }
    </script>
  </body>
</html>`;
}

export async function startPreviewServer(options: PreviewOptions) {
  const dir = path.resolve(options.dir);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${options.host}:${options.port}`);
    try {
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const [issue, text] = await Promise.all([
          readOptional(path.join(dir, "issue.json"), "{}"),
          readOptional(path.join(dir, "email.txt")),
        ]);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(previewShell(issue, text));
        return;
      }

      const files: Record<string, [string, string]> = {
        "/email.html": ["email.html", "text/html; charset=utf-8"],
        "/email.txt": ["email.txt", "text/plain; charset=utf-8"],
        "/issue.json": ["issue.json", "application/json; charset=utf-8"],
      };
      const file = files[url.pathname];
      if (!file) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }

      const body = await readFile(path.join(dir, file[0]), "utf8");
      res.writeHead(200, { "content-type": file[1] });
      res.end(body);
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(error instanceof Error ? error.message : String(error));
    }
  });

  await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve));
  return server;
}
