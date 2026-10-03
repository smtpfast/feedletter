import { createHash } from "node:crypto";

export const SMTPFAST_DEFAULT_BASE_URL = "https://smtpfa.st/api";
export const SMTPFAST_SIGNUP_URL = "https://smtpfa.st";
export const UNSUBSCRIBE_PLACEHOLDER = "{{unsubscribe_url}}";

export interface SmtpfastMessage {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text?: string;
}

export interface SmtpfastConfig {
  apiKey: string;
  baseUrl?: string;
}

export interface SendResult {
  recipient: string;
  ok: boolean;
  id?: string;
  error?: string;
  /** SMTPfast dropped the address because it unsubscribed, bounced, or complained before. */
  suppressed?: boolean;
  /** An earlier run of this exact send already reached this address, so it was skipped. */
  alreadySent?: boolean;
}

/** SMTPfast accepts up to 100 emails per POST /v1/emails/batch call. */
export const BATCH_SIZE = 100;
/** SMTPfast stores broadcast HTML up to this many characters. */
export const BROADCAST_HTML_LIMIT = 100_000;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 60000;

export class SmtpfastError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SmtpfastError";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retry-After is either seconds or an HTTP date. */
function retryAfterMs(header: string | null, attempt: number) {
  if (header) {
    const seconds = Number.parseFloat(header);
    if (Number.isFinite(seconds)) return Math.max(seconds, 0) * 1000;
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(date - Date.now(), 0);
  }
  return 1000 * 2 ** attempt;
}

function hint(status: number) {
  if (status === 401) return " Check the API key (SMTPfast dashboard, API keys).";
  if (status === 403) return " The key may lack the scope, or the From domain is not verified.";
  return "";
}

/**
 * One call to the SMTPfast API. A 429 is retried after Retry-After, up to
 * three times: SMTPfast rate-limits before it queues anything, so the retry
 * cannot double-send. Other errors are not retried.
 */
async function smtpfastRequest<T>(
  config: SmtpfastConfig,
  method: "GET" | "POST",
  pathname: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const base = (config.baseUrl ?? SMTPFAST_DEFAULT_BASE_URL).replace(/\/$/, "");
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    let text: string;
    try {
      response = await fetch(`${base}${pathname}`, {
        method,
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // Bun's fetch replays a request once when a pooled connection drops
        // after it was sent, which would send a batch twice. No reuse for POSTs.
        keepalive: method === "GET",
        signal: controller.signal,
      });
      text = await response.text();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new SmtpfastError(`SMTPfast did not answer within ${REQUEST_TIMEOUT_MS / 1000}s.`);
      }
      throw new SmtpfastError(`Could not reach SMTPfast: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }

    let rateLimitNote = "";
    if (response.status === 429) {
      const waitMs = retryAfterMs(response.headers.get("retry-after"), attempt);
      if (attempt < MAX_RATE_LIMIT_RETRIES && waitMs <= MAX_RETRY_WAIT_MS) {
        await sleep(waitMs);
        continue;
      }
      rateLimitNote =
        waitMs > MAX_RETRY_WAIT_MS
          ? ` SMTPfast asked to wait ${Math.ceil(waitMs / 1000)}s; try again later.`
          : ` Still rate-limited after ${MAX_RATE_LIMIT_RETRIES} retries; try again later.`;
    }

    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`.trim();
      try {
        const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
        const detail = typeof parsed.error === "string" ? parsed.error : typeof parsed.message === "string" ? parsed.message : "";
        if (detail) message = `${detail} (${response.status})`;
      } catch {
        if (text.trim()) message = `${text.trim().slice(0, 300)} (${response.status})`;
      }
      throw new SmtpfastError(`SMTPfast: ${message}.${hint(response.status)}${rateLimitNote}`.replace(/\.\./g, "."), response.status);
    }

    try {
      return (text ? JSON.parse(text) : {}) as T;
    } catch {
      return {} as T;
    }
  }
}

const SIMPLE_EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** The same address check SMTPfast applies, so a bad address is caught before it fails a whole batch. */
export function isValidEmail(address: string): boolean {
  if (address.length > 320 || !SIMPLE_EMAIL_RE.test(address)) return false;
  return DOMAIN_RE.test(address.slice(address.lastIndexOf("@") + 1).toLowerCase());
}

export interface RecipientCheck {
  valid: string[];
  invalid: string[];
  duplicates: number;
}

/** Trim, drop case-insensitive duplicates, and split out addresses SMTPfast would reject. */
export function checkRecipients(recipients: string[]): RecipientCheck {
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  let duplicates = 0;
  for (const raw of recipients) {
    const address = raw.trim();
    if (!address) continue;
    const key = address.toLowerCase();
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    (isValidEmail(address) ? valid : invalid).push(address);
  }
  return { valid, invalid, duplicates };
}

interface BatchResponse {
  batch_id?: string;
  emails?: Array<{ id?: string; status?: string }>;
}

/** Identifies one exact send (sender, subject, and body), for the recipient checkpoint. */
export function sendKey(message: Omit<SmtpfastMessage, "to">) {
  return createHash("sha256").update(`${message.from}\n${message.subject}\n${message.html}\n${message.text ?? ""}`).digest("hex");
}

/**
 * Progress of one send, kept between runs. The batch endpoint has no
 * idempotency, so after a partial failure a rerun would send the accepted
 * batches again; the checkpoint lets it skip addresses SMTPfast already took.
 */
export interface SendCheckpoint {
  /** Lowercased addresses SMTPfast already accepted for this exact send. */
  alreadySent: Set<string>;
  /** Called after each accepted batch, before the next one goes out. */
  record(accepted: SendResult[]): Promise<void> | void;
}

/**
 * Send one message per recipient so each gets their own {{unsubscribe_url}} and
 * nobody sees the rest of the list. Rows go out through the batch endpoint, up
 * to 100 per call. Returns a per-recipient result set.
 */
export async function sendDigest(
  config: SmtpfastConfig,
  base: Omit<SmtpfastMessage, "to">,
  recipients: string[],
  options: { checkpoint?: SendCheckpoint } = {},
): Promise<SendResult[]> {
  const { valid, invalid } = checkRecipients(recipients);
  const results: SendResult[] = invalid.map((recipient) => ({ recipient, ok: false, error: "not a valid email address" }));
  const checkpoint = options.checkpoint;
  const pending: string[] = [];
  for (const recipient of valid) {
    if (checkpoint?.alreadySent.has(recipient.toLowerCase())) {
      results.push({ recipient, ok: false, alreadySent: true, error: "already sent in an earlier run" });
    } else {
      pending.push(recipient);
    }
  }

  let stopError: string | undefined;
  for (let start = 0; start < pending.length; start += BATCH_SIZE) {
    const chunk = pending.slice(start, start + BATCH_SIZE);
    if (stopError) {
      results.push(...chunk.map((recipient) => ({ recipient, ok: false, error: `not sent: ${stopError}` })));
      continue;
    }
    let accepted: SendResult[];
    try {
      const response = await smtpfastRequest<BatchResponse>(
        config,
        "POST",
        "/v1/emails/batch",
        chunk.map((recipient) => ({ ...base, to: [recipient] })),
      );
      accepted = chunk.map((recipient, index) => {
        const row = response.emails?.[index];
        return row?.status === "failed"
          ? { recipient, ok: false, suppressed: true, id: row.id, error: "suppressed (unsubscribed, bounced, or complained before)" }
          : { recipient, ok: true, id: row?.id };
      });
    } catch (error) {
      // A batch is all-or-nothing on SMTPfast's side, and the same content will
      // fail the same way, so stop instead of repeating it for every chunk.
      let message = error instanceof Error ? error.message : String(error);
      if (error instanceof SmtpfastError && error.status === undefined) {
        // No HTTP answer: the batch may still have been queued.
        message += " This batch may have been queued anyway; check the SMTPfast logs before sending again.";
      }
      results.push(...chunk.map((recipient) => ({ recipient, ok: false, error: message })));
      stopError = "an earlier batch failed";
      continue;
    }
    results.push(...accepted);
    if (checkpoint) {
      try {
        await checkpoint.record(accepted);
      } catch (error) {
        // Without a saved checkpoint a rerun would resend this batch, so stop here.
        stopError = `could not save send progress (${error instanceof Error ? error.message : String(error)})`;
      }
    }
  }
  return results;
}

export function parseRecipients(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

interface SmtpfastDomain {
  domain: string;
  status: string;
}

export interface DomainCheck {
  found: boolean;
  verified: boolean;
  status?: string;
}

/**
 * Check whether the domain of a From address is a verified SMTPfast sending
 * domain. Returns found=false when it is not registered on the account.
 */
export async function verifyFromDomain(config: SmtpfastConfig, from: string): Promise<DomainCheck> {
  const angle = from.match(/<([^>]+)>/);
  const address = (angle ? angle[1] : from).trim();
  const at = address.lastIndexOf("@");
  const host = (at >= 0 ? address.slice(at + 1) : address).trim().toLowerCase();
  if (!host) return { found: false, verified: false };

  const domains = await smtpfastRequest<SmtpfastDomain[] | { data?: SmtpfastDomain[] }>(config, "GET", "/v1/domains");
  const list = Array.isArray(domains) ? domains : Array.isArray(domains.data) ? domains.data : [];
  const match = list.find((d) => typeof d.domain === "string" && d.domain.toLowerCase() === host);
  if (!match) return { found: false, verified: false };
  return { found: true, verified: match.status === "verified", status: match.status };
}

// ---- Broadcasts: send to SMTPfast contacts or a segment ----

export interface AudienceSegment {
  id: string;
  name: string;
  contactCount: number;
}

export interface AudienceSummary {
  total: number;
  eligible: number;
  skipped: number;
  segments: AudienceSegment[];
  planLabel?: string;
  broadcastLimit?: number;
  broadcastsUsed?: number;
}

/** The body of GET /v1/broadcasts/audience (SMTPfast's audience route). */
interface AudienceResponse {
  object?: "broadcast_audience";
  audience_type?: "all_contacts" | "segment";
  segment_id?: string | null;
  audience?: { total?: number; eligible?: number; skipped?: number; unsubscribed?: number; suppressed?: number; invalid?: number };
  domains?: Array<{ id?: string; domain?: string }>;
  segments?: Array<{ id?: string; name?: string; color?: string | null; contact_count?: number }>;
  package?: { tier?: string; label?: string; broadcast_limit?: number; broadcasts_used?: number };
}

/** How many contacts a broadcast would reach, the segments to choose from, and the monthly broadcast allowance. */
export async function getAudience(config: SmtpfastConfig, segmentId?: string): Promise<AudienceSummary> {
  const query = segmentId ? `?segment_id=${encodeURIComponent(segmentId)}` : "";
  let data: AudienceResponse;
  try {
    data = await smtpfastRequest<AudienceResponse>(config, "GET", `/v1/broadcasts/audience${query}`);
  } catch (error) {
    const scope = error instanceof SmtpfastError && error.status === 403 ? " Reading the audience needs an API key with the email:read scope." : "";
    throw new SmtpfastError(`Could not check the SMTPfast audience. ${error instanceof Error ? error.message : String(error)}${scope}`, error instanceof SmtpfastError ? error.status : undefined);
  }
  if (typeof data.audience?.eligible !== "number" || typeof data.audience?.total !== "number") {
    throw new SmtpfastError("Could not check the SMTPfast audience: the response did not include audience counts.");
  }
  const total = data.audience.total;
  const eligible = data.audience.eligible;
  return {
    total,
    eligible,
    skipped: data.audience?.skipped ?? Math.max(total - eligible, 0),
    segments: (data.segments ?? [])
      .filter((segment) => typeof segment.id === "string")
      .map((segment) => ({ id: segment.id!, name: segment.name ?? segment.id!, contactCount: segment.contact_count ?? 0 })),
    planLabel: data.package?.label,
    broadcastLimit: data.package?.broadcast_limit,
    broadcastsUsed: data.package?.broadcasts_used,
  };
}

/** Find a segment by id or by name (case-insensitive). */
export function findSegment(segments: AudienceSegment[], idOrName: string): AudienceSegment | undefined {
  const wanted = idOrName.trim().toLowerCase();
  return segments.find((segment) => segment.id === idOrName.trim()) ?? segments.find((segment) => segment.name.toLowerCase() === wanted);
}

export interface BroadcastDraft {
  name: string;
  from: string;
  subject: string;
  previewText?: string;
  html: string;
  text?: string;
  segmentId?: string;
}

export interface BroadcastResult {
  id: string;
  status: string;
  url: string;
  recipients?: number;
  skipped?: number;
}

export function broadcastUrl(id: string) {
  return `${SMTPFAST_SIGNUP_URL}/broadcasts/${encodeURIComponent(id)}`;
}

/** Create a broadcast draft. Nothing is sent until sendBroadcast (or Send in the dashboard). */
export async function createBroadcast(config: SmtpfastConfig, draft: BroadcastDraft): Promise<BroadcastResult> {
  if (draft.html.length > BROADCAST_HTML_LIMIT) {
    throw new SmtpfastError(
      `The email HTML is ${draft.html.length.toLocaleString("en")} characters; SMTPfast broadcasts accept up to ${BROADCAST_HTML_LIMIT.toLocaleString("en")}. Include fewer items.`,
    );
  }
  const data = await smtpfastRequest<{ id?: string; status?: string }>(config, "POST", "/v1/broadcasts", {
    name: draft.name.slice(0, 140),
    from: draft.from,
    subject: draft.subject.slice(0, 255),
    preview_text: draft.previewText ? draft.previewText.slice(0, 255) : undefined,
    html: draft.html,
    text: draft.text,
    ...(draft.segmentId ? { audience: "segment", segment_id: draft.segmentId } : { audience: "all_contacts" }),
  });
  if (!data.id) throw new SmtpfastError("SMTPfast did not return a broadcast id.");
  return { id: data.id, status: data.status ?? "draft", url: broadcastUrl(data.id) };
}

/** Statuses that mean the broadcast already went out, or is going out. */
export const BROADCAST_SENT_STATUSES = new Set(["scheduled", "queued", "sending", "sent", "paused"]);

/** Read a broadcast's current status. */
export async function getBroadcast(config: SmtpfastConfig, id: string): Promise<BroadcastResult> {
  const data = await smtpfastRequest<{ id?: string; status?: string; recipient_count?: number }>(
    config,
    "GET",
    `/v1/broadcasts/${encodeURIComponent(id)}`,
  );
  return { id, status: data.status ?? "unknown", url: broadcastUrl(id), recipients: data.recipient_count };
}

/**
 * Create a draft, and if SMTPfast gave no answer, look for the draft it may
 * have created anyway, so a retry does not leave a second one behind.
 */
export async function createBroadcastOnce(config: SmtpfastConfig, draft: BroadcastDraft): Promise<BroadcastResult> {
  try {
    return await createBroadcast(config, draft);
  } catch (error) {
    if (!(error instanceof SmtpfastError) || error.status !== undefined) throw error;
    const name = draft.name.slice(0, 140);
    const since = Date.now() - 15 * 60 * 1000;
    try {
      const list = await smtpfastRequest<{ data?: Array<{ id?: string; name?: string; subject?: string; created_at?: string }> }>(
        config,
        "GET",
        `/v1/broadcasts?status=draft&limit=20&q=${encodeURIComponent(name)}`,
      );
      const match = (list.data ?? []).find(
        (b) => b.id && b.name === name && b.subject === draft.subject.slice(0, 255) && Date.parse(b.created_at ?? "") >= since,
      );
      if (match?.id) return { id: match.id, status: "draft", url: broadcastUrl(match.id) };
    } catch {
      /* fall through to the original error */
    }
    throw new SmtpfastError(`${error.message} If SMTPfast created the draft anyway, it is named "${name}"; check before retrying.`);
  }
}

/**
 * Send a draft, and if the answer is lost or an error comes back, read the
 * broadcast before reporting failure: the send may have gone through.
 */
export async function sendBroadcastChecked(config: SmtpfastConfig, id: string): Promise<BroadcastResult & { recovered?: boolean }> {
  try {
    return await sendBroadcast(config, id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let current: BroadcastResult;
    try {
      current = await getBroadcast(config, id);
    } catch {
      throw new SmtpfastError(`${message} Broadcast ${id} may have been sent; check ${broadcastUrl(id)} before sending again.`);
    }
    if (BROADCAST_SENT_STATUSES.has(current.status)) return { ...current, recovered: true };
    throw new SmtpfastError(`${message} Broadcast ${id} was not sent (status: ${current.status}); the draft is at ${current.url}.`);
  }
}

/** Send a broadcast draft now to its audience. */
export async function sendBroadcast(config: SmtpfastConfig, id: string): Promise<BroadcastResult> {
  const data = await smtpfastRequest<{ id?: string; status?: string; recipients?: number; skipped?: number }>(
    config,
    "POST",
    `/v1/broadcasts/${encodeURIComponent(id)}/send`,
    {},
  );
  return { id, status: data.status ?? "queued", url: broadcastUrl(id), recipients: data.recipients, skipped: data.skipped };
}
