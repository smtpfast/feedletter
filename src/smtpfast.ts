import { mapWithConcurrency } from "./utils.js";

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
}

const SEND_CONCURRENCY = 4;
const SEND_TIMEOUT_MS = 20000;

async function postEmail(config: SmtpfastConfig, message: SmtpfastMessage): Promise<{ id?: string }> {
  const base = (config.baseUrl ?? SMTPFAST_DEFAULT_BASE_URL).replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${base}/v1/emails`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(message),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`SMTPfast request timed out after ${SEND_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const bodyText = await response.text();
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const parsed = JSON.parse(bodyText) as { error?: string; message?: string };
      if (parsed.error || parsed.message) message = parsed.error ?? parsed.message ?? message;
    } catch {
      if (bodyText.trim()) message = bodyText.trim();
    }
    throw new Error(message);
  }

  try {
    return JSON.parse(bodyText) as { id?: string };
  } catch {
    return {};
  }
}

/**
 * Send one message per recipient so each gets their own {{unsubscribe_url}} and
 * nobody sees the rest of the list. Returns a per-recipient result set.
 */
export async function sendDigest(
  config: SmtpfastConfig,
  base: Omit<SmtpfastMessage, "to">,
  recipients: string[],
): Promise<SendResult[]> {
  const unique = [...new Set(recipients.map((r) => r.trim()).filter(Boolean))];
  return mapWithConcurrency(unique, SEND_CONCURRENCY, async (recipient) => {
    try {
      const result = await postEmail(config, { ...base, to: [recipient] });
      return { recipient, ok: true, id: result.id } satisfies SendResult;
    } catch (error) {
      return {
        recipient,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies SendResult;
    }
  });
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

  const base = (config.baseUrl ?? SMTPFAST_DEFAULT_BASE_URL).replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/v1/domains`, {
      headers: { authorization: `Bearer ${config.apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    const domains = (await res.json()) as SmtpfastDomain[];
    const match = Array.isArray(domains)
      ? domains.find((d) => typeof d.domain === "string" && d.domain.toLowerCase() === host)
      : undefined;
    if (!match) return { found: false, verified: false };
    return { found: true, verified: match.status === "verified", status: match.status };
  } finally {
    clearTimeout(timer);
  }
}
