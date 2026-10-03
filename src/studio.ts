import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import path from "node:path";
import { buildFallbackIssue, enrichIssueWithAi } from "./ai.js";
import { loadContentDirectory } from "./content.js";
import { HistoryStore, itemHistoryKey } from "./history.js";
import { renderHtml, renderText } from "./render.js";
import { loadRssFeed } from "./rss.js";
import { parseRecipients, sendDigest, verifyFromDomain, SMTPFAST_DEFAULT_BASE_URL, SMTPFAST_SIGNUP_URL, UNSUBSCRIBE_PLACEHOLDER } from "./smtpfast.js";
import { renderStudioPage } from "./studio-ui.js";
import type { DigestIssue, SourceItem } from "./types.js";
import { enrichIssueWithCommand } from "./writer.js";

export interface StudioOptions {
  host: string;
  port: number;
  contentDir?: string;
  baseUrl?: string;
  defaultFrom?: string;
  historyDb?: string;
  history?: boolean;
  agentCommand?: string;
  agentTimeoutMs?: number;
}

interface ServerContext extends StudioOptions {
  aiEnabled: boolean;
  aiBaseUrl: string;
  aiModel?: string;
  historyStore?: HistoryStore;
}

const MAX_BODY_BYTES = 5 * 1024 * 1024;
/** Lowercase a host and strip IPv6 brackets: "[::1]" and "::1" compare equal. */
function normalizeHost(host: string) {
  return host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
}

/** The hostname part of a Host header, without the port. */
function hostnameOf(hostHeader: string | undefined) {
  if (!hostHeader) return "";
  const value = hostHeader.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  return normalizeHost(bracketed ? bracketed[1] : value.replace(/:\d+$/, ""));
}

function isIpv6Loopback(address: string) {
  if (/^::ffff:127\./.test(address)) return true;
  const [head, tail] = address.includes("::") ? address.split("::") : [address, undefined];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(8 - left.length - right.length, 0)).fill("0"), ...right];
  return groups.length === 8 && groups.slice(0, 7).every((group) => /^0+$/.test(group)) && /^0*1$/.test(groups[7]);
}

/** localhost (any case), any 127.0.0.0/8 address, or ::1 in any spelling. */
export function isLoopbackHost(host: string) {
  const h = normalizeHost(host);
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (isIP(h) === 4) return h.startsWith("127.");
  if (isIP(h) === 6) return isIpv6Loopback(h);
  return false;
}

/**
 * Whether the Host check applies: the bind address resolves to a loopback
 * address (127.1 and 2130706433 do), or it cannot be resolved (fail closed).
 * Binding to a non-loopback address such as 0.0.0.0 is an explicit opt-in.
 */
export async function bindNeedsHostGuard(bindHost: string): Promise<boolean> {
  const host = normalizeHost(bindHost);
  if (isLoopbackHost(host)) return true;
  if (isIP(host)) return false;
  try {
    const addresses = await lookup(host, { all: true });
    return addresses.length === 0 || addresses.some((entry) => isLoopbackHost(entry.address));
  } catch {
    return true;
  }
}

/**
 * The studio is a local tool that can read local folders, run the writer
 * command, and send email, so only the studio page itself may call its API.
 * Returns an error message for a request a web page elsewhere could make.
 */
export function rejectForeignRequest(req: IncomingMessage, hostGuard: boolean): string | undefined {
  const host = hostnameOf(req.headers.host);
  // On a loopback bind, a Host that is not a loopback name means DNS rebinding.
  // The Origin and content-type checks below apply to every bind.
  if (hostGuard && !isLoopbackHost(host)) return "Unknown host.";
  if (req.method !== "POST") return undefined;
  const origin = req.headers.origin;
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return "Cross-origin requests are not allowed.";
    }
    if (originHost !== (req.headers.host ?? "").trim().toLowerCase()) return "Cross-origin requests are not allowed.";
  }
  // A JSON content type forces a CORS preflight for any cross-site caller.
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return "Send JSON with Content-Type: application/json.";
  return undefined;
}

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
      image: typeof input.image === "string" ? input.image : undefined,
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
    return sendJson(res, 200, { items: withSeen(items, ctx), sourceLabel });
  }

  const dir = toStringField(body.content).trim() || ctx.contentDir;
  if (!dir) return sendJson(res, 400, { error: "Enter a local content directory." });
  const items = await loadContentDirectory({
    dir: path.resolve(dir),
    baseUrl: toStringField(body.baseUrl).trim() || ctx.baseUrl,
    limit,
  });
  return sendJson(res, 200, { items: withSeen(items, ctx), sourceLabel: "Local content" });
}

function withSeen(items: SourceItem[], ctx: ServerContext): Array<SourceItem & { seen?: boolean }> {
  if (!ctx.historyStore) return items;
  const seen = ctx.historyStore.seenKeys(items);
  return items.map((item) => ({ ...item, seen: seen.has(itemHistoryKey(item)) }));
}

async function handleVerifyDomain(req: IncomingMessage, res: ServerResponse) {
  const body = await readJson<Record<string, unknown>>(req);
  const apiKey = toStringField(body.apiKey).trim();
  const from = toStringField(body.from).trim();
  const baseUrl = toStringField(body.baseUrl).trim() || SMTPFAST_DEFAULT_BASE_URL;
  if (!apiKey || !from) return sendJson(res, 400, { error: "API key and From address are required." });
  try {
    const check = await verifyFromDomain({ apiKey, baseUrl }, from);
    return sendJson(res, 200, check);
  } catch (error) {
    return sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function handleRender(req: IncomingMessage, res: ServerResponse) {
  const draft = await readJson<Record<string, unknown>>(req);
  const issue = issueFromDraft(draft);
  return sendJson(res, 200, { html: renderHtml(issue), text: renderText(issue) });
}

async function handleEnrich(req: IncomingMessage, res: ServerResponse, ctx: ServerContext) {
  if (!ctx.agentCommand && !ctx.aiEnabled) {
    return sendJson(res, 400, {
      error:
        "No writer configured. Set OPENAI_API_KEY (or AI_API_KEY) + AI_MODEL for the API, or pass --agent-command \"claude -p\", then restart studio.",
    });
  }
  const draft = await readJson<Record<string, unknown>>(req);
  const tone = toStringField(draft.tone) || "clear, useful, developer-friendly";
  const source = issueFromDraft(draft);
  const fallback = buildFallbackIssue(source.title, source.intro, source.sourceLabel, source.items, source.instructions);
  const base: DigestIssue = { ...fallback, preheader: source.preheader || fallback.preheader };

  // The external agent command (claude -p, codex, a custom script) takes
  // precedence when configured, so a user can opt out of the API entirely.
  const enriched = ctx.agentCommand
    ? await enrichIssueWithCommand(base, ctx.agentCommand, tone, ctx.agentTimeoutMs ?? 120000)
    : await enrichIssueWithAi(base, {
        enabled: true,
        baseUrl: ctx.aiBaseUrl,
        apiKey: process.env.OPENAI_API_KEY ?? process.env.AI_API_KEY,
        model: ctx.aiModel,
        tone,
      });

  return sendJson(res, 200, {
    title: enriched.title,
    preheader: enriched.preheader,
    intro: enriched.intro,
    items: enriched.items,
  });
}

async function handleSend(req: IncomingMessage, res: ServerResponse, ctx: ServerContext) {
  const body = await readJson<Record<string, unknown>>(req);
  const apiKey = toStringField(body.apiKey).trim();
  const from = toStringField(body.from).trim();
  const subject = toStringField(body.subject).trim();
  const recipients = parseRecipients(toStringField(body.recipients));
  const html = toStringField(body.html);
  const text = toStringField(body.text);
  const baseUrl = toStringField(body.baseUrl).trim() || SMTPFAST_DEFAULT_BASE_URL;
  const isTest = body.test === true;

  if (!apiKey) return sendJson(res, 400, { error: "Paste your SMTPfast API key." });
  if (!from) return sendJson(res, 400, { error: "Enter a verified sender address." });
  if (!subject) return sendJson(res, 400, { error: "Add a subject line." });
  if (recipients.length === 0) {
    return sendJson(res, 400, { error: isTest ? "Enter a test address." : "Add at least one recipient." });
  }
  if (!html) return sendJson(res, 400, { error: "Nothing to send yet. Load a source first." });

  const results = await sendDigest({ apiKey, baseUrl }, { from, subject, html, text }, recipients);
  const sent = results.filter((r) => r.ok).length;

  // Record a real send in history so the same items are not sent twice. Test
  // sends never touch history.
  if (!isTest && sent > 0 && ctx.historyStore) {
    const items = normalizeItems(body.items);
    if (items.length > 0) {
      try {
        await ctx.historyStore.recordIssue({
          title: subject,
          preheader: "",
          intro: "",
          items,
          generatedAt: new Date().toISOString(),
          sourceLabel: toStringField(body.sourceLabel, "Digest"),
        });
      } catch {
        /* history is best-effort; never fail a send over it */
      }
    }
  }

  return sendJson(res, 200, { sent, failed: results.length - sent, results });
}

export async function startStudioServer(options: StudioOptions) {
  const ctx: ServerContext = {
    ...options,
    aiEnabled: Boolean((process.env.OPENAI_API_KEY ?? process.env.AI_API_KEY) && (process.env.AI_MODEL ?? "")),
    aiBaseUrl: process.env.AI_BASE_URL ?? "https://api.openai.com/v1",
    aiModel: process.env.AI_MODEL,
  };

  if (options.history !== false) {
    try {
      ctx.historyStore = await HistoryStore.open(path.resolve(options.historyDb ?? ".feedletter/feedletter.sqlite"));
    } catch {
      // History is optional. If sql.js cannot initialize, run without dedup.
      ctx.historyStore = undefined;
    }
  }

  const writerLabel = ctx.agentCommand
    ? /claude/i.test(ctx.agentCommand)
      ? "Claude"
      : /codex/i.test(ctx.agentCommand)
        ? "Codex"
        : "your agent"
    : ctx.aiEnabled
      ? "AI"
      : null;

  const page = renderStudioPage({
    writerLabel,
    defaultFrom: options.defaultFrom ?? "",
    defaultContentDir: options.contentDir ?? "",
    signupUrl: SMTPFAST_SIGNUP_URL,
    unsubscribePlaceholder: UNSUBSCRIBE_PLACEHOLDER,
    historyEnabled: Boolean(ctx.historyStore),
  });

  const hostGuard = await bindNeedsHostGuard(options.host);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${options.host}:${options.port}`);
    try {
      const rejection = rejectForeignRequest(req, hostGuard);
      if (rejection) return void sendJson(res, 403, { error: rejection });
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/load") return void (await handleLoad(req, res, ctx));
      if (req.method === "POST" && url.pathname === "/api/render") return void (await handleRender(req, res));
      if (req.method === "POST" && url.pathname === "/api/enrich") return void (await handleEnrich(req, res, ctx));
      if (req.method === "POST" && url.pathname === "/api/verify-domain") return void (await handleVerifyDomain(req, res));
      if (req.method === "POST" && url.pathname === "/api/send") return void (await handleSend(req, res, ctx));

      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve));
  return server;
}
