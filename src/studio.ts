import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import path from "node:path";
import { buildFallbackIssue, enrichIssueWithAi } from "./ai.js";
import { loadContentDirectory } from "./content.js";
import { HistoryStore, itemHistoryKey } from "./history.js";
import { renderHtml, renderText } from "./render.js";
import { loadRssFeed } from "./rss.js";
import {
  BROADCAST_SENT_STATUSES,
  broadcastUrl,
  checkRecipients,
  createBroadcastOnce,
  getAudience,
  getBroadcast,
  parseRecipients,
  sendBroadcastChecked,
  sendDigest,
  sendKey,
  SmtpfastError,
  verifyFromDomain,
  type SendCheckpoint,
  SMTPFAST_DEFAULT_BASE_URL,
  SMTPFAST_SIGNUP_URL,
  UNSUBSCRIBE_PLACEHOLDER,
} from "./smtpfast.js";
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
  /** A list send or broadcast is running; a second one is refused until it ends. */
  sending?: boolean;
  /** Send progress when there is no history store, kept for this process only. */
  memorySent: Map<string, Set<string>>;
  memoryBroadcasts: Map<string, string>;
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
 * The studio is a local tool that can read local folders, run the writer
 * command, and send email, so only the studio page itself may call its API.
 * Returns an error message for a request a web page elsewhere could make.
 */
export function rejectForeignRequest(req: IncomingMessage, bindHost: string): string | undefined {
  const host = hostnameOf(req.headers.host);
  // On a loopback bind, a Host that is not a loopback name means DNS rebinding.
  // Binding to another interface is an explicit opt-in, so any Host is accepted
  // there; the Origin and content-type checks below still apply.
  if (isLoopbackHost(bindHost) && !isLoopbackHost(host)) return "Unknown host.";
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

/** Record a real send so the same items are not sent twice. Best-effort: never fail a send over it. */
async function recordSent(ctx: ServerContext, subject: string, items: SourceItem[], sourceLabel: string) {
  if (!ctx.historyStore || items.length === 0) return;
  try {
    await ctx.historyStore.recordIssue({
      title: subject,
      preheader: "",
      intro: "",
      items,
      generatedAt: new Date().toISOString(),
      sourceLabel,
    });
  } catch {
    /* history is best-effort */
  }
}

function smtpfastConfig(body: Record<string, unknown>) {
  return {
    apiKey: toStringField(body.apiKey).trim(),
    baseUrl: toStringField(body.baseUrl).trim() || SMTPFAST_DEFAULT_BASE_URL,
  };
}

/** Render the email on the server from the studio draft, always with a per-recipient unsubscribe link. */
function renderSendable(body: Record<string, unknown>) {
  const draft = body.draft && typeof body.draft === "object" ? (body.draft as Record<string, unknown>) : undefined;
  if (!draft) {
    return {
      subject: toStringField(body.subject).trim(),
      html: toStringField(body.html),
      text: toStringField(body.text),
      items: normalizeItems(body.items),
      sourceLabel: toStringField(body.sourceLabel, "Digest"),
      preheader: "",
    };
  }
  const issue = issueFromDraft({ ...draft, includeUnsubscribe: true, unsubscribeUrl: UNSUBSCRIBE_PLACEHOLDER });
  return {
    subject: toStringField(draft.title).trim(),
    html: issue.items.length > 0 ? renderHtml(issue) : "",
    text: issue.items.length > 0 ? renderText(issue) : "",
    items: issue.items,
    sourceLabel: issue.sourceLabel,
    preheader: issue.preheader,
  };
}

const BUSY_MESSAGE = "Another send is still running. Wait for it to finish, then try again.";

/** Accepted addresses for one exact send: in the history DB, or in memory with --no-history. */
function checkpointFor(ctx: ServerContext, key: string): SendCheckpoint {
  const store = ctx.historyStore;
  if (store) return { alreadySent: store.sentRecipients(key), record: (rows) => store.recordRecipients(key, rows) };
  const sent = ctx.memorySent.get(key) ?? new Set<string>();
  ctx.memorySent.set(key, sent);
  return { alreadySent: new Set(sent), record: (rows) => rows.forEach((row) => sent.add(row.recipient.toLowerCase())) };
}

async function handleSend(req: IncomingMessage, res: ServerResponse, ctx: ServerContext) {
  const body = await readJson<Record<string, unknown>>(req);
  const config = smtpfastConfig(body);
  const from = toStringField(body.from).trim();
  const recipients = parseRecipients(toStringField(body.recipients));
  const isTest = body.test === true;
  const email = renderSendable(body);

  if (!config.apiKey) return sendJson(res, 400, { error: "Paste your SMTPfast API key." });
  if (!from) return sendJson(res, 400, { error: "Enter a verified sender address." });
  if (!email.subject) return sendJson(res, 400, { error: "Add a subject line." });
  if (recipients.length === 0) {
    return sendJson(res, 400, { error: isTest ? "Enter a test address." : "Add at least one recipient." });
  }
  if (!email.html) return sendJson(res, 400, { error: "Nothing to send yet. Load a source and tick at least one item." });
  const checked = checkRecipients(recipients);
  if (checked.valid.length === 0) {
    return sendJson(res, 400, { error: `No valid addresses to send to: ${checked.invalid.slice(0, 5).join(", ")}` });
  }
  if (!isTest && ctx.sending) return sendJson(res, 409, { error: BUSY_MESSAGE });

  const message = { from, subject: email.subject, html: email.html, text: email.text };
  if (!isTest) ctx.sending = true;
  try {
    // A rerun of this exact send skips addresses an earlier run already reached.
    const checkpoint = isTest ? undefined : checkpointFor(ctx, sendKey(message));
    const results = await sendDigest(config, message, checked.valid, { checkpoint });
    for (const recipient of checked.invalid) results.push({ recipient, ok: false, error: "not a valid email address" });
    const sent = results.filter((r) => r.ok).length;
    const skipped = results.filter((r) => r.suppressed).length;
    const alreadySent = results.filter((r) => r.alreadySent).length;

    // Test sends never touch history.
    if (!isTest && sent + alreadySent > 0) await recordSent(ctx, email.subject, email.items, email.sourceLabel);

    return sendJson(res, 200, { sent, skipped, alreadySent, failed: results.length - sent - skipped - alreadySent, results });
  } finally {
    if (!isTest) ctx.sending = false;
  }
}

async function handleAudience(req: IncomingMessage, res: ServerResponse) {
  const body = await readJson<Record<string, unknown>>(req);
  const config = smtpfastConfig(body);
  if (!config.apiKey) return sendJson(res, 400, { error: "Paste your SMTPfast API key." });
  const segmentId = toStringField(body.segmentId).trim() || undefined;
  try {
    return sendJson(res, 200, await getAudience(config, segmentId));
  } catch (error) {
    return sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function handleBroadcast(req: IncomingMessage, res: ServerResponse, ctx: ServerContext) {
  const body = await readJson<Record<string, unknown>>(req);
  const config = smtpfastConfig(body);
  const from = toStringField(body.from).trim();
  const segmentId = toStringField(body.segmentId).trim() || undefined;
  const sendNow = body.send === true;
  const email = renderSendable(body);

  if (!config.apiKey) return sendJson(res, 400, { error: "Paste your SMTPfast API key." });
  if (!from) return sendJson(res, 400, { error: "Enter a verified sender address." });
  if (!email.subject) return sendJson(res, 400, { error: "Add a subject line." });
  if (!email.html) return sendJson(res, 400, { error: "Nothing to send yet. Load a source and tick at least one item." });
  if (ctx.sending) return sendJson(res, 409, { error: BUSY_MESSAGE });

  const key = `broadcast:${segmentId ?? "all"}:${sendKey({ from, subject: email.subject, html: email.html, text: email.text })}`;
  let broadcastId: string | undefined;
  ctx.sending = true;
  try {
    // Reuse the broadcast created for this exact email, so a retry after a lost
    // answer never creates (or sends) a second campaign.
    broadcastId = ctx.memoryBroadcasts.get(key) ?? ctx.historyStore?.broadcastFor(key);
    if (broadcastId) {
      let existing;
      try {
        existing = await getBroadcast(config, broadcastId);
      } catch (error) {
        if (!(error instanceof SmtpfastError && error.status === 404)) throw error;
      }
      if (existing && BROADCAST_SENT_STATUSES.has(existing.status)) {
        return sendJson(res, 409, {
          error: `This email already went out as a broadcast (${existing.status}). Change it to send again.`,
          url: existing.url,
          broadcastId,
        });
      }
      if (existing?.status !== "draft") broadcastId = undefined;
    }
    const reused = Boolean(broadcastId);
    if (!broadcastId) {
      const draft = await createBroadcastOnce(config, {
        name: toStringField(body.name).trim() || email.subject,
        from,
        subject: email.subject,
        previewText: email.preheader,
        html: email.html,
        text: email.text,
        segmentId,
      });
      broadcastId = draft.id;
      ctx.memoryBroadcasts.set(key, draft.id);
      await ctx.historyStore?.recordBroadcast(key, draft.id);
    }
    if (!sendNow) return sendJson(res, 200, { id: broadcastId, status: "draft", url: broadcastUrl(broadcastId), reused });

    const sent = await sendBroadcastChecked(config, broadcastId);
    await recordSent(ctx, email.subject, email.items, email.sourceLabel);
    return sendJson(res, 200, sent);
  } catch (error) {
    return sendJson(res, 502, {
      error: error instanceof Error ? error.message : String(error),
      ...(broadcastId ? { url: broadcastUrl(broadcastId), broadcastId } : {}),
    });
  } finally {
    ctx.sending = false;
  }
}

export async function startStudioServer(options: StudioOptions) {
  const ctx: ServerContext = {
    ...options,
    memorySent: new Map(),
    memoryBroadcasts: new Map(),
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

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${options.host}:${options.port}`);
    try {
      const rejection = rejectForeignRequest(req, options.host);
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
      if (req.method === "POST" && url.pathname === "/api/audience") return void (await handleAudience(req, res));
      if (req.method === "POST" && url.pathname === "/api/broadcast") return void (await handleBroadcast(req, res, ctx));

      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve));
  return server;
}
