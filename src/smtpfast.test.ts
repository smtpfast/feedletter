import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HistoryStore } from "./history.js";
import {
  BROADCAST_HTML_LIMIT,
  checkRecipients,
  createBroadcast,
  createBroadcastOnce,
  findSegment,
  getAudience,
  parseRecipients,
  sendBroadcast,
  sendBroadcastChecked,
  sendDigest,
  sendKey,
  verifyFromDomain,
  type SendCheckpoint,
} from "./smtpfast.js";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | Error;

const realFetch = globalThis.fetch;
let calls: Call[] = [];

// Plain global swap instead of vi.stubGlobal, so the suite also runs under `bun test`.
function mockApi(handler: (call: Call, index: number) => Reply) {
  calls = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const reply = handler(call, calls.length - 1);
    if (reply instanceof Error) throw reply;
    const status = reply.status ?? 200;
    return new Response(JSON.stringify(reply.body ?? {}), {
      status,
      statusText: status === 200 ? "OK" : "Error",
      headers: { "content-type": "application/json", ...reply.headers },
    });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

const config = { apiKey: "k", baseUrl: "https://api.test" };
const message = { from: "news@example.com", subject: "Hi", html: "<p>hi {{unsubscribe_url}}</p>", text: "hi" };
const okBatch = (call: Call) => ({ body: { batch_id: "b", emails: (call.body as unknown[]).map((_, i) => ({ id: `e${i}`, status: "queued" })) } });

describe("parseRecipients", () => {
  it("splits on commas, spaces, semicolons, and newlines", () => {
    expect(parseRecipients("a@x.com, b@x.com\n c@x.com;d@x.com")).toEqual(["a@x.com", "b@x.com", "c@x.com", "d@x.com"]);
  });

  it("drops empties", () => {
    expect(parseRecipients("  , ,a@x.com,")).toEqual(["a@x.com"]);
  });
});

describe("checkRecipients", () => {
  it("drops case-insensitive duplicates and splits out invalid addresses", () => {
    const result = checkRecipients(["a@x.com", "A@X.com", "nope", "b@x", "c@sub.example.org", "d@-bad.com"]);
    expect(result.valid).toEqual(["a@x.com", "c@sub.example.org"]);
    expect(result.invalid).toEqual(["nope", "b@x", "d@-bad.com"]);
    expect(result.duplicates).toBe(1);
  });
});

describe("sendDigest", () => {
  it("sends one row per recipient through the batch endpoint, 100 per call", async () => {
    mockApi(okBatch);
    const recipients = Array.from({ length: 250 }, (_, i) => `user${i}@example.com`);
    const results = await sendDigest(config, message, recipients);

    expect(calls.map((c) => [c.url, (c.body as unknown[]).length])).toEqual([
      ["https://api.test/v1/emails/batch", 100],
      ["https://api.test/v1/emails/batch", 100],
      ["https://api.test/v1/emails/batch", 50],
    ]);
    const firstRow = (calls[0].body as Array<{ to: string[]; html: string }>)[0];
    expect(firstRow.to).toEqual(["user0@example.com"]);
    expect(firstRow.html).toContain("{{unsubscribe_url}}");
    // The batch endpoint does not honour Idempotency-Key, so none is sent.
    expect(calls[0].headers["idempotency-key"]).toBeUndefined();
    expect(results.filter((r) => r.ok)).toHaveLength(250);
  });

  it("resumes after a partial failure without resending accepted batches", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "feedletter-checkpoint-"));
    const store = await HistoryStore.open(path.join(dir, "history.sqlite"));
    try {
      const key = sendKey(message);
      const checkpoint = (): SendCheckpoint => ({ alreadySent: store.sentRecipients(key), record: (rows) => store.recordRecipients(key, rows) });
      const recipients = Array.from({ length: 150 }, (_, i) => `user${i}@example.com`);

      // First run: batch 1 is accepted, batch 2 fails.
      mockApi((call, index) => (index === 0 ? okBatch(call) : { status: 500, body: { error: "Internal error" } }));
      const first = await sendDigest(config, message, recipients, { checkpoint: checkpoint() });
      expect(first.filter((r) => r.ok)).toHaveLength(100);
      expect(first.filter((r) => !r.ok)).toHaveLength(50);

      // Rerun: only the 50 that failed go out.
      mockApi(okBatch);
      const second = await sendDigest(config, message, recipients, { checkpoint: checkpoint() });
      expect(calls).toHaveLength(1);
      expect((calls[0].body as Array<{ to: string[] }>).map((row) => row.to[0])).toEqual(recipients.slice(100));
      expect(second.filter((r) => r.alreadySent)).toHaveLength(100);
      expect(second.filter((r) => r.ok)).toHaveLength(50);

      // Different content is a different send, so nobody is skipped.
      const edited = sendKey({ ...message, subject: "Hi again" });
      expect(store.sentRecipients(edited).size).toBe(0);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips invalid addresses and reports suppressed rows", async () => {
    mockApi(() => ({ body: { emails: [{ id: "e0", status: "queued" }, { id: "e1", status: "failed" }] } }));
    const results = await sendDigest(config, message, ["a@example.com", "b@example.com", "broken"]);
    expect((calls[0].body as unknown[]).length).toBe(2);
    expect(results.find((r) => r.recipient === "broken")).toMatchObject({ ok: false, error: "not a valid email address" });
    expect(results.find((r) => r.recipient === "b@example.com")).toMatchObject({ ok: false, suppressed: true });
    expect(results.find((r) => r.recipient === "a@example.com")).toMatchObject({ ok: true, id: "e0" });
  });

  it("waits for Retry-After before retrying a 429", async () => {
    mockApi((call, index) => (index === 0 ? { status: 429, body: { error: "Rate limit exceeded" }, headers: { "retry-after": "0.3" } } : okBatch(call)));
    const started = Date.now();
    const results = await sendDigest(config, message, ["a@example.com"]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(calls).toHaveLength(2);
    expect(results[0].ok).toBe(true);
  });

  it("gives up after three 429 retries", async () => {
    mockApi(() => ({ status: 429, body: { error: "Rate limit exceeded" }, headers: { "retry-after": "0" } }));
    const [result] = await sendDigest(config, message, ["a@example.com"]);
    expect(calls).toHaveLength(4);
    expect(result.error).toMatch(/after 3 retries/);
  });

  it("does not wait out a long Retry-After", async () => {
    mockApi(() => ({ status: 429, body: { error: "Hourly sending limit reached" }, headers: { "retry-after": "1800" } }));
    const [result] = await sendDigest(config, message, ["a@example.com"]);
    expect(calls).toHaveLength(1);
    expect(result.error).toMatch(/asked to wait 1800s/);
  });

  it("stops after a rejected batch instead of repeating it for every chunk", async () => {
    mockApi(() => ({ status: 403, body: { error: "Item 0: domain example.com is not verified" } }));
    const recipients = Array.from({ length: 150 }, (_, i) => `user${i}@example.com`);
    const results = await sendDigest(config, message, recipients);
    expect(calls).toHaveLength(1);
    expect(results[0].error).toMatch(/not verified \(403\)/);
    expect(results[149].error).toBe("not sent: an earlier batch failed");
  });

  it("does not replay a batch when the connection drops after it was sent", async () => {
    let batches = 0;
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        batches++;
        // The first batch is answered and leaves a reusable connection; the second is dropped unanswered.
        if (batches >= 2) return void req.socket.destroy();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ emails: [{ id: "e0", status: "queued" }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const local = { apiKey: "k", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
      expect((await sendDigest(local, message, ["a@example.com"]))[0].ok).toBe(true);
      const [dropped] = await sendDigest(local, { ...message, subject: "Second" }, ["b@example.com"]);
      expect(dropped.error).toMatch(/may have been queued/);
      expect(batches).toBe(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("warns that a batch with no answer may still have been queued", async () => {
    mockApi(() => new TypeError("socket hang up"));
    const [result] = await sendDigest(config, message, ["a@example.com"]);
    expect(result.error).toMatch(/may have been queued/);
  });
});

describe("verifyFromDomain", () => {
  const domains = (list: unknown, status = 200) => mockApi(() => ({ status, body: list }));

  it("reports a verified domain", async () => {
    domains([{ domain: "mail.example.com", status: "verified" }]);
    const check = await verifyFromDomain({ apiKey: "k" }, "News <news@mail.example.com>");
    expect(check).toEqual({ found: true, verified: true, status: "verified" });
  });

  it("reports a found but unverified domain", async () => {
    domains([{ domain: "example.com", status: "pending" }]);
    const check = await verifyFromDomain({ apiKey: "k" }, "hi@example.com");
    expect(check.found).toBe(true);
    expect(check.verified).toBe(false);
  });

  it("reports a domain not on the account", async () => {
    domains([{ domain: "other.com", status: "verified" }]);
    expect(await verifyFromDomain({ apiKey: "k" }, "hi@example.com")).toEqual({ found: false, verified: false });
  });

  it("throws on an auth error", async () => {
    domains({ error: "Invalid API key" }, 401);
    await expect(verifyFromDomain({ apiKey: "bad" }, "hi@example.com")).rejects.toThrow(/401/);
  });
});

// The exact body of SMTPfast's GET /v1/broadcasts/audience (src/app/api/v1/broadcasts/audience/route.ts).
const audienceBody = (segmentId: string | null = null) => ({
  object: "broadcast_audience",
  audience_type: segmentId ? "segment" : "all_contacts",
  segment_id: segmentId,
  audience: { total: 12, eligible: 10, skipped: 2, unsubscribed: 1, suppressed: 1, invalid: 0 },
  domains: [{ id: "dom_1", domain: "example.com" }],
  segments: [{ id: "seg_1", name: "Customers", color: "#10b981", contact_count: 4 }],
  package: { tier: "starter", label: "Starter", broadcast_limit: 10, broadcasts_used: 3 },
});

describe("broadcasts", () => {
  it("reads the audience, segments, and monthly allowance", async () => {
    mockApi(() => ({ body: audienceBody("seg_1") }));
    const audience = await getAudience(config, "seg_1");
    expect(calls[0].url).toBe("https://api.test/v1/broadcasts/audience?segment_id=seg_1");
    expect(audience).toMatchObject({ eligible: 10, skipped: 2, broadcastLimit: 10, broadcastsUsed: 3, planLabel: "Starter" });
    expect(findSegment(audience.segments, "customers")?.id).toBe("seg_1");
    expect(findSegment(audience.segments, "seg_1")?.name).toBe("Customers");
  });

  it("explains a failed audience lookup instead of blocking silently", async () => {
    mockApi(() => ({ status: 403, body: { error: "API key does not have email:read scope" } }));
    await expect(getAudience(config)).rejects.toThrow(/Could not check the SMTPfast audience.*email:read/);
    mockApi(() => ({ body: { object: "broadcast_audience" } }));
    await expect(getAudience(config)).rejects.toThrow(/did not include audience counts/);
  });

  it("treats a lost send answer as sent when SMTPfast shows the broadcast going out", async () => {
    mockApi((call) => (call.url.endsWith("/send") ? new TypeError("socket hang up") : { body: { object: "broadcast", id: "bc_1", status: "queued", recipient_count: 10, recipients: [] } }));
    const sent = await sendBroadcastChecked(config, "bc_1");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["POST https://api.test/v1/broadcasts/bc_1/send", "GET https://api.test/v1/broadcasts/bc_1"]);
    expect(sent).toMatchObject({ status: "queued", recipients: 10, recovered: true });
  });

  it("reports a failed send with the draft link when the broadcast is still a draft", async () => {
    mockApi((call) => (call.url.endsWith("/send") ? { status: 500, body: { error: "Internal error" } } : { body: { id: "bc_1", status: "draft" } }));
    await expect(sendBroadcastChecked(config, "bc_1")).rejects.toThrow(/was not sent \(status: draft\).*broadcasts\/bc_1/);
  });

  it("finds the draft SMTPfast created when the create answer was lost", async () => {
    mockApi((call) =>
      call.method === "POST"
        ? new TypeError("socket hang up")
        : { body: { object: "list", data: [{ id: "bc_9", name: "Weekly", subject: "Hi", created_at: new Date().toISOString() }] } },
    );
    const draft = await createBroadcastOnce(config, { name: "Weekly", from: "news@example.com", subject: "Hi", html: "<p>{{unsubscribe_url}}</p>" });
    expect(draft.id).toBe("bc_9");
    expect(calls[1].url).toContain("/v1/broadcasts?status=draft");
  });

  it("creates a draft for a segment and links to it", async () => {
    mockApi(() => ({ status: 201, body: { id: "bc_1", status: "draft" } }));
    const draft = await createBroadcast(config, { name: "Weekly", from: "news@example.com", subject: "Hi", previewText: "pre", html: "<p>{{unsubscribe_url}}</p>", segmentId: "seg_1" });
    expect(calls[0].body).toMatchObject({ name: "Weekly", audience: "segment", segment_id: "seg_1", preview_text: "pre" });
    expect(draft.url).toBe("https://smtpfa.st/broadcasts/bc_1");
  });

  it("refuses HTML over the broadcast limit before calling the API", async () => {
    mockApi(() => ({ body: {} }));
    await expect(
      createBroadcast(config, { name: "n", from: "a@example.com", subject: "s", html: "x".repeat(BROADCAST_HTML_LIMIT + 1) }),
    ).rejects.toThrow(/fewer items/);
    expect(calls).toHaveLength(0);
  });

  it("sends a draft and returns the recipient count", async () => {
    mockApi(() => ({ body: { id: "bc_1", status: "queued", recipients: 10, skipped: 2 } }));
    const sent = await sendBroadcast(config, "bc_1");
    expect(calls[0].url).toBe("https://api.test/v1/broadcasts/bc_1/send");
    expect(sent).toMatchObject({ status: "queued", recipients: 10 });
  });
});
