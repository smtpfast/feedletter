import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { buildFallbackIssue, enrichIssueWithAi } from "./ai.js";
import { loadContentDirectory } from "./content.js";
import { renderHtml, renderText } from "./render.js";
import { loadRssFeed } from "./rss.js";
import { parseRecipients, sendDigest, SMTPFAST_DEFAULT_BASE_URL, SMTPFAST_SIGNUP_URL, UNSUBSCRIBE_PLACEHOLDER } from "./smtpfast.js";
import { renderStudioPage } from "./studio-ui.js";
import type { DigestIssue, SourceItem } from "./types.js";

export interface StudioOptions {
  host: string;
  port: number;
  contentDir?: string;
  baseUrl?: string;
  defaultFrom?: string;
}

interface ServerContext extends StudioOptions {
  aiEnabled: boolean;
  aiBaseUrl: string;
  aiModel?: string;
}

const MAX_BODY_BYTES = 5 * 1024 * 1024;

function readJson<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return resolve({} as T);
      try {
        resolve(JSON.parse(raw) as T);
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

function toStringField(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function normalizeItems(value: unknown): SourceItem[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const input = (item ?? {}) as Record<string, unknown>;
    return {
      title: toStringField(input.title, "Untitled"),
      url: typeof input.url === "string" ? input.url : undefined,
      summary: typeof input.summary === "string" ? input.summary : undefined,
      content: typeof input.content === "string" ? input.content : undefined,
      date: typeof input.date === "string" ? input.date : undefined,
      author: typeof input.author === "string" ? input.author : undefined,
      source: typeof input.source === "string" ? input.source : undefined,
    } satisfies SourceItem;
  });
}

function issueFromDraft(draft: Record<string, unknown>): DigestIssue {
  const items = normalizeItems(draft.items);
  const includeUnsubscribe = draft.includeUnsubscribe !== false;
  return {
    title: toStringField(draft.title, "Latest updates"),
    preheader: toStringField(draft.preheader),
    intro: toStringField(draft.intro),
    sourceLabel: toStringField(draft.sourceLabel, "Digest"),
    generatedAt: toStringField(draft.generatedAt) || new Date().toISOString(),
    items,
    instructions: typeof draft.instructions === "string" ? draft.instructions : undefined,
    unsubscribeUrl: includeUnsubscribe ? toStringField(draft.unsubscribeUrl) || UNSUBSCRIBE_PLACEHOLDER : undefined,
    footerNote: typeof draft.footerNote === "string" && draft.footerNote.trim() ? draft.footerNote : undefined,
  };
}

async function handleLoad(req: IncomingMessage, res: ServerResponse, ctx: ServerContext) {
  const body = await readJson<Record<string, unknown>>(req);
  const type = body.type === "content" ? "content" : "rss";
  const limit = Math.min(Math.max(Number.parseInt(String(body.limit ?? "10"), 10) || 10, 1), 50);

  if (type === "rss") {
    const url = toStringField(body.rss).trim();
    if (!url) return sendJson(res, 400, { error: "Enter an RSS or Atom feed URL." });
    const items = await loadRssFeed({ url, limit });
    let sourceLabel = "Feed";
    try {
      sourceLabel = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      /* keep default */
    }
    return sendJson(res, 200, { items, sourceLabel });
  }

  const dir = toStringField(body.content).trim() || ctx.contentDir;
  if (!dir) return sendJson(res, 400, { error: "Enter a local content directory." });
  const items = await loadContentDirectory({
    dir: path.resolve(dir),
    baseUrl: toStringField(body.baseUrl).trim() || ctx.baseUrl,
    limit,
  });
  return sendJson(res, 200, { items, sourceLabel: "Local content" });
}

async function handleRender(req: IncomingMessage, res: ServerResponse) {
  const draft = await readJson<Record<string, unknown>>(req);
  const issue = issueFromDraft(draft);
  return sendJson(res, 200, { html: renderHtml(issue), text: renderText(issue) });
}

async function handleEnrich(req: IncomingMessage, res: ServerResponse, ctx: ServerContext) {
  if (!ctx.aiEnabled) {
    return sendJson(res, 400, {
      error: "AI is not configured. Set OPENAI_API_KEY (or AI_API_KEY) and AI_MODEL, then restart studio.",
    });
  }
  const draft = await readJson<Record<string, unknown>>(req);
  const tone = toStringField(draft.tone) || "clear, useful, developer-friendly";
  const source = issueFromDraft(draft);
  const fallback = buildFallbackIssue(source.title, source.intro, source.sourceLabel, source.items, source.instructions);
  const enriched = await enrichIssueWithAi(
    { ...fallback, preheader: source.preheader || fallback.preheader },
    {
      enabled: true,
      baseUrl: ctx.aiBaseUrl,
      apiKey: process.env.OPENAI_API_KEY ?? process.env.AI_API_KEY,
      model: ctx.aiModel,
      tone,
    },
  );
  return sendJson(res, 200, {
    title: enriched.title,
    preheader: enriched.preheader,
    intro: enriched.intro,
    items: enriched.items,
  });
}

async function handleSend(req: IncomingMessage, res: ServerResponse) {
  const body = await readJson<Record<string, unknown>>(req);
  const apiKey = toStringField(body.apiKey).trim();
  const from = toStringField(body.from).trim();
  const subject = toStringField(body.subject).trim();
  const recipients = parseRecipients(toStringField(body.recipients));
  const html = toStringField(body.html);
  const text = toStringField(body.text);
  const baseUrl = toStringField(body.baseUrl).trim() || SMTPFAST_DEFAULT_BASE_URL;

  if (!apiKey) return sendJson(res, 400, { error: "Paste your SMTPfast API key." });
  if (!from) return sendJson(res, 400, { error: "Enter a verified sender address." });
  if (!subject) return sendJson(res, 400, { error: "Add a subject line." });
  if (recipients.length === 0) return sendJson(res, 400, { error: "Add at least one recipient." });
  if (!html) return sendJson(res, 400, { error: "Nothing to send yet. Load a source first." });

  const results = await sendDigest({ apiKey, baseUrl }, { from, subject, html, text }, recipients);
  const sent = results.filter((r) => r.ok).length;
  return sendJson(res, 200, { sent, failed: results.length - sent, results });
}

export async function startStudioServer(options: StudioOptions) {
  const ctx: ServerContext = {
    ...options,
    aiEnabled: Boolean((process.env.OPENAI_API_KEY ?? process.env.AI_API_KEY) && (process.env.AI_MODEL ?? "")),
    aiBaseUrl: process.env.AI_BASE_URL ?? "https://api.openai.com/v1",
    aiModel: process.env.AI_MODEL,
  };

  const page = renderStudioPage({
    aiEnabled: ctx.aiEnabled,
    defaultFrom: options.defaultFrom ?? "",
    defaultContentDir: options.contentDir ?? "",
    signupUrl: SMTPFAST_SIGNUP_URL,
    unsubscribePlaceholder: UNSUBSCRIBE_PLACEHOLDER,
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${options.host}:${options.port}`);
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/load") return void (await handleLoad(req, res, ctx));
      if (req.method === "POST" && url.pathname === "/api/render") return void (await handleRender(req, res));
      if (req.method === "POST" && url.pathname === "/api/enrich") return void (await handleEnrich(req, res, ctx));
      if (req.method === "POST" && url.pathname === "/api/send") return void (await handleSend(req, res));

      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve));
  return server;
}
