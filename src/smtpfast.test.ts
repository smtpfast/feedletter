import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HistoryStore } from "./history.js";
import {
  BROADCAST_HTML_LIMIT,
  batchIdempotencyKey,
  checkRecipients,
  createBroadcast,
  checkSavedBroadcast,
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
    // Each batch carries its own key, made from the issue and its addresses.
    const keys = calls.map((c) => c.headers["idempotency-key"]);
    expect(keys[0]).toMatch(/^feedletter-[0-9a-f]{40}$/);
    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).toBe(batchIdempotencyKey(sendKey(message), recipients.slice(0, 100)));
    expect(results.filter((r) => r.ok)).toHaveLength(250);
  });

  async function withStore(fn: (store: HistoryStore) => Promise<void>) {
    const dir = await mkdtemp(path.join(tmpdir(), "feedletter-checkpoint-"));
    const store = await HistoryStore.open(path.join(dir, "history.sqlite"));
    try {
      await fn(store);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
  const checkpointFor = (store: HistoryStore, resend = false): SendCheckpoint => {
    const key = sendKey(message);
    return {
      previous: resend ? new Map() : store.sentRecipients(key),
      record: (rows, state, batchKey) => store.recordRecipients(key, rows, state, batchKey),
      forget: (recipients) => store.forgetRecipients(key, recipients),
      uncertainBatches: () => (resend ? [] : store.uncertainBatches(key)),
      release: (recipients) => store.releaseUncertain(key, recipients),
    };
  };
  // Every history write happens under the lock, as in the CLI and the studio.
  const send = (store: HistoryStore, list: string[], resend = false) =>
    store.exclusive(() => sendDigest(config, message, list, { checkpoint: checkpointFor(store, resend), retryDelaysMs: [0, 0] }));
  const recipients150 = Array.from({ length: 150 }, (_, i) => `user${i}@example.com`);

  it("resends only the refused batch on a rerun after a 4xx", async () => {
    await withStore(async (store) => {
      // SMTPfast refuses with a 4xx before it queues anything.
      mockApi((call, index) => (index === 0 ? okBatch(call) : { status: 403, body: { error: "Item 0: domain example.com is not verified" } }));
      const first = await send(store, recipients150);
      expect(first.filter((r) => r.ok)).toHaveLength(100);
      expect(first.filter((r) => r.uncertain)).toHaveLength(0);

      mockApi(okBatch);
      const second = await send(store, recipients150);
      expect(calls).toHaveLength(1);
      expect((calls[0].body as Array<{ to: string[] }>).map((row) => row.to[0])).toEqual(recipients150.slice(100));
      expect(second.filter((r) => r.alreadySent)).toHaveLength(100);
      expect(second.filter((r) => r.ok)).toHaveLength(50);
      expect(store.sentRecipients(sendKey({ ...message, subject: "Hi again" })).size).toBe(0);
    });
  });

  it("retries a 5xx with the same key and body, so a retry cannot send twice", async () => {
    mockApi((call, index) => (index < 2 ? { status: 502, body: { error: "Bad gateway" } } : okBatch(call)));
    const results = await sendDigest(config, message, ["a@example.com", "b@example.com"], { retryDelaysMs: [0, 0] });
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.headers["idempotency-key"])).size).toBe(1);
    expect(new Set(calls.map((c) => JSON.stringify(c.body))).size).toBe(1);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("does not retry a 409 and does not treat it as a refusal", async () => {
    mockApi(() => ({ status: 409, body: { error: "This Idempotency-Key was used more than 24 hours ago. Send with a new key." } }));
    const [result] = await sendDigest(config, message, ["a@example.com"], { retryDelaysMs: [0, 0] });
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, uncertain: true });
  });

  it("marks a batch that is still unknown after the retries as uncertain, stops, and replays it with its key on a rerun", async () => {
    await withStore(async (store) => {
      const recipients = Array.from({ length: 250 }, (_, i) => `user${i}@example.com`);
      mockApi((call, index) => (index === 0 ? okBatch(call) : { status: 500, body: { error: "Internal error" } }));
      const first = await send(store, recipients);
      // The first batch, then the second one three times (two retries), then stop.
      expect(calls).toHaveLength(4);
      expect(first.filter((r) => r.ok)).toHaveLength(100);
      expect(first.filter((r) => r.uncertain)).toHaveLength(100);
      expect(first.filter((r) => /stopped after a batch with an unknown outcome/.test(r.error ?? ""))).toHaveLength(50);
      const failedKey = calls[1].headers["idempotency-key"];

      // The rerun replays the uncertain batch with the same key and body, then sends the 50 that never went out.
      mockApi(okBatch);
      const second = await send(store, recipients);
      expect(calls).toHaveLength(2);
      expect(calls[0].headers["idempotency-key"]).toBe(failedKey);
      expect((calls[0].body as Array<{ to: string[] }>).map((row) => row.to[0])).toEqual(recipients.slice(100, 200));
      expect((calls[1].body as Array<{ to: string[] }>).map((row) => row.to[0])).toEqual(recipients.slice(200));
      expect(second.filter((r) => r.ok)).toHaveLength(150);
      expect(second.filter((r) => r.alreadySent)).toHaveLength(100);
      expect(second.filter((r) => r.uncertain)).toHaveLength(0);

      // Everyone is recorded as sent now.
      mockApi(okBatch);
      const third = await send(store, recipients);
      expect(calls).toHaveLength(0);
      expect(third.filter((r) => r.alreadySent)).toHaveLength(250);
    });
  });

  it("keeps a batch uncertain when its key can no longer be replayed", async () => {
    await withStore(async (store) => {
      mockApi(() => ({ status: 500, body: { error: "Internal error" } }));
      await send(store, ["a@example.com"]);
      // More than 24 hours later SMTPfast answers the old key with a 409.
      mockApi(() => ({ status: 409, body: { error: "This Idempotency-Key was used more than 24 hours ago. Send with a new key." } }));
      const [result] = await send(store, ["a@example.com"]);
      expect(calls).toHaveLength(1);
      expect(result).toMatchObject({ ok: false, uncertain: true });
      // --resend sends again with a fresh write-ahead.
      mockApi(okBatch);
      const [again] = await send(store, ["a@example.com"], true);
      expect(again.ok).toBe(true);
    });
  });

  it("sends an uncertain batch normally when SMTPfast shows it never went out", async () => {
    await withStore(async (store) => {
      mockApi(() => new TypeError("socket hang up"));
      await send(store, ["a@example.com", "b@example.com"]);
      // A 4xx on the replay means no batch was stored under that key: nothing went out before.
      mockApi((call, index) => (index === 0 ? { status: 403, body: { error: "domain not verified" } } : okBatch(call)));
      const results = await send(store, ["a@example.com", "b@example.com"]);
      expect(calls).toHaveLength(2);
      expect(results.every((r) => r.ok)).toBe(true);
    });
  });

  it("does not replay a batch whose recipients changed", async () => {
    await withStore(async (store) => {
      mockApi(() => ({ status: 500, body: { error: "Internal error" } }));
      await send(store, ["a@example.com", "b@example.com"]);
      mockApi(okBatch);
      // b@ is no longer on the list, so the stored batch cannot be repeated exactly; a@ stays uncertain.
      const results = await send(store, ["a@example.com", "c@example.com"]);
      expect(calls).toHaveLength(1);
      expect((calls[0].body as Array<{ to: string[] }>).map((row) => row.to[0])).toEqual(["c@example.com"]);
      expect(results.find((r) => r.recipient === "a@example.com")).toMatchObject({ uncertain: true });
    });
  });

  it("writes each batch ahead as uncertain before it goes out, then marks it sent or forgets it", async () => {
    const states = new Map<string, "sent" | "uncertain">();
    const checkpoint: SendCheckpoint = {
      previous: new Map(),
      record: (rows, state) => rows.forEach((row) => states.set(row.recipient, state)),
      forget: (list) => list.forEach((recipient) => states.delete(recipient)),
    };
    let atPost = new Map<string, string>();
    mockApi((call) => {
      atPost = new Map(states);
      return okBatch(call);
    });
    await sendDigest(config, message, ["a@example.com", "b@example.com"], { checkpoint });
    expect([...atPost]).toEqual([["a@example.com", "uncertain"], ["b@example.com", "uncertain"]]);
    expect([...states.values()]).toEqual(["sent", "sent"]);

    // A refused batch (4xx) queued nothing, so its write-ahead entries are removed.
    states.clear();
    mockApi(() => ({ status: 403, body: { error: "domain not verified" } }));
    await sendDigest(config, message, ["c@example.com"], { checkpoint });
    expect(states.size).toBe(0);

    // A crash between SMTPfast's answer and the "sent" write leaves the batch uncertain, never unrecorded.
    states.clear();
    mockApi(okBatch);
    const crashing: SendCheckpoint = {
      ...checkpoint,
      record: (rows, state) => {
        if (state === "sent") throw new Error("disk full");
        checkpoint.record(rows, state);
      },
    };
    const [result] = await sendDigest(config, message, ["d@example.com"], { checkpoint: crashing });
    expect(result.ok).toBe(true);
    expect(states.get("d@example.com")).toBe("uncertain");
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
    expect(results[0].uncertain).toBeUndefined();
    expect(results[149].error).toBe("not sent: an earlier batch was refused");
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
      // No retries here: this checks that fetch itself never repeats a POST.
      const [dropped] = await sendDigest(local, { ...message, subject: "Second" }, ["b@example.com"], { retryDelaysMs: [] });
      expect(dropped).toMatchObject({ ok: false, uncertain: true });
      expect(batches).toBe(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("marks a batch with no answer as uncertain", async () => {
    mockApi(() => new TypeError("socket hang up"));
    const [result] = await sendDigest(config, message, ["a@example.com"], { retryDelaysMs: [0, 0] });
    expect(calls).toHaveLength(3);
    expect(result).toMatchObject({ ok: false, uncertain: true });
    expect(result.error).toMatch(/may have sent this batch/);
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

  it("does not report a failed or canceled broadcast as sent", async () => {
    mockApi((call) => (call.url.endsWith("/send") ? new TypeError("socket hang up") : { body: { id: "bc_1", status: "failed" } }));
    await expect(sendBroadcastChecked(config, "bc_1")).rejects.toThrow(/status "failed"; some contacts may have it/);
  });

  it("stops when the answer to a create is lost, and never looks for a draft by name", async () => {
    mockApi(() => new TypeError("socket hang up"));
    await expect(
      createBroadcast(config, { name: "Weekly", from: "news@example.com", subject: "Hi", html: "<p>{{unsubscribe_url}}</p>" }),
    ).rejects.toThrow(/may have created the draft anyway. Check your broadcasts/);
    expect(calls.map((c) => c.method)).toEqual(["POST"]);
  });

  it("decides what to do with a saved broadcast from its status", async () => {
    const expected = { from: "news@example.com", subject: "Hi" };
    const status = (value: string, code = 200) =>
      mockApi(() =>
        code === 200
          ? { body: { id: "bc_1", status: value, audience: "all_contacts", audience_meta: {}, from: "news@example.com", subject: "Hi" } }
          : { status: code, body: { error: "Broadcast not found" } },
      );
    status("draft");
    expect(await checkSavedBroadcast(config, "bc_1", expected)).toEqual({ action: "reuse", id: "bc_1" });
    status("", 404);
    expect(await checkSavedBroadcast(config, "bc_1", expected)).toEqual({ action: "create" });
    for (const sent of ["scheduled", "queued", "sending", "sent", "paused"]) {
      status(sent);
      expect(await checkSavedBroadcast(config, "bc_1", expected)).toMatchObject({ action: "stop", message: expect.stringMatching(/already went out/) });
    }
    for (const partial of ["failed", "canceled"]) {
      status(partial);
      expect(await checkSavedBroadcast(config, "bc_1", expected)).toMatchObject({ action: "stop", message: expect.stringMatching(/some contacts may already have it/) });
    }
    status("archived");
    expect(await checkSavedBroadcast(config, "bc_1", expected)).toMatchObject({ action: "stop", message: expect.stringMatching(/cannot tell/) });
  });

  it("never reuses a draft whose audience, sender, or subject was changed in the dashboard", async () => {
    const draft = (fields: Record<string, unknown>) =>
      mockApi(() => ({ body: { id: "bc_1", status: "draft", audience: "segment", audience_meta: { segment_id: "seg_a" }, from: "news@example.com", subject: "Hi", ...fields } }));
    const expected = { from: "news@example.com", subject: "Hi", segmentId: "seg_a" };
    draft({});
    expect(await checkSavedBroadcast(config, "bc_1", expected)).toEqual({ action: "reuse", id: "bc_1" });
    draft({ audience: "all_contacts", audience_meta: {} });
    expect(await checkSavedBroadcast(config, "bc_1", expected)).toMatchObject({ action: "stop", message: expect.stringMatching(/audience is all_contacts, this run wants segment seg_a/) });
    draft({ audience_meta: { segment_id: "seg_b" } });
    expect(await checkSavedBroadcast(config, "bc_1", expected)).toMatchObject({ action: "stop", message: expect.stringMatching(/segment seg_b/) });
    draft({ from: "other@example.com" });
    expect(await checkSavedBroadcast(config, "bc_1", expected)).toMatchObject({ action: "stop", message: expect.stringMatching(/sender is other@example.com/) });
    draft({ subject: "Edited" });
    expect(await checkSavedBroadcast(config, "bc_1", expected)).toMatchObject({ action: "stop", message: expect.stringMatching(/subject is different/) });
  });

  it("creates a draft for a segment and links to it", async () => {
    mockApi(() => ({ status: 201, body: { id: "bc_1", status: "draft" } }));
    const draft = await createBroadcast(config, { name: "Weekly", from: "news@example.com", subject: "Hi", previewText: "pre", html: "<p>{{unsubscribe_url}}</p>", segmentId: "seg_1" });
    expect(calls[0].body).toMatchObject({ name: "Weekly", audience: "segment", segment_id: "seg_1", preview_text: "pre" });
    expect(draft.url).toBe("https://smtpfa.st/broadcasts/bc_1");
  });

  it("refuses HTML over the broadcast limit before calling the API, with no recovery", async () => {
    mockApi(() => ({ body: {} }));
    const attempt = createBroadcast(config, { name: "n", from: "a@example.com", subject: "s", html: "x".repeat(BROADCAST_HTML_LIMIT + 1) });
    await expect(attempt).rejects.toThrow(/fewer items/);
    await expect(attempt).rejects.not.toThrow(/may have created/);
    await expect(attempt).rejects.toMatchObject({ noAnswer: false });
    expect(calls).toHaveLength(0);
  });

  it("sends a draft and returns the recipient count", async () => {
    mockApi(() => ({ body: { id: "bc_1", status: "queued", recipients: 10, skipped: 2 } }));
    const sent = await sendBroadcast(config, "bc_1");
    expect(calls[0].url).toBe("https://api.test/v1/broadcasts/bc_1/send");
    expect(sent).toMatchObject({ status: "queued", recipients: 10 });
  });
});
