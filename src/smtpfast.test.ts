import { afterEach, describe, expect, it } from "vitest";
import {
  BROADCAST_HTML_LIMIT,
  checkRecipients,
  createBroadcast,
  findSegment,
  getAudience,
  parseRecipients,
  sendBroadcast,
  sendDigest,
  verifyFromDomain,
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
    expect(calls[0].headers["idempotency-key"]).toMatch(/^feedletter-/);
    expect(results.filter((r) => r.ok)).toHaveLength(250);
  });

  it("leaves the idempotency key off a test send", async () => {
    mockApi(okBatch);
    await sendDigest(config, message, ["me@example.com"], { idempotent: false });
    expect(calls[0].headers["idempotency-key"]).toBeUndefined();
  });

  it("skips invalid addresses and reports suppressed rows", async () => {
    mockApi(() => ({ body: { emails: [{ id: "e0", status: "queued" }, { id: "e1", status: "failed" }] } }));
    const results = await sendDigest(config, message, ["a@example.com", "b@example.com", "broken"]);
    expect((calls[0].body as unknown[]).length).toBe(2);
    expect(results.find((r) => r.recipient === "broken")).toMatchObject({ ok: false, error: "not a valid email address" });
    expect(results.find((r) => r.recipient === "b@example.com")).toMatchObject({ ok: false, suppressed: true });
    expect(results.find((r) => r.recipient === "a@example.com")).toMatchObject({ ok: true, id: "e0" });
  });

  it("retries a 429 after Retry-After", async () => {
    mockApi((call, index) => (index === 0 ? { status: 429, body: { error: "Rate limit exceeded" }, headers: { "retry-after": "0" } } : okBatch(call)));
    const results = await sendDigest(config, message, ["a@example.com"]);
    expect(calls).toHaveLength(2);
    expect(results[0].ok).toBe(true);
  });

  it("stops after a rejected batch instead of repeating it for every chunk", async () => {
    mockApi(() => ({ status: 403, body: { error: "Item 0: domain example.com is not verified" } }));
    const recipients = Array.from({ length: 150 }, (_, i) => `user${i}@example.com`);
    const results = await sendDigest(config, message, recipients);
    expect(calls).toHaveLength(1);
    expect(results[0].error).toMatch(/not verified \(403\)/);
    expect(results[149].error).toBe("not sent: an earlier batch failed");
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

describe("broadcasts", () => {
  it("reads the audience, segments, and monthly allowance", async () => {
    mockApi(() => ({
      body: {
        audience: { total: 12, eligible: 10, skipped: 2 },
        segments: [{ id: "seg_1", name: "Customers", contact_count: 4 }],
        package: { label: "Starter", broadcast_limit: 10, broadcasts_used: 3 },
      },
    }));
    const audience = await getAudience(config, "seg_1");
    expect(calls[0].url).toBe("https://api.test/v1/broadcasts/audience?segment_id=seg_1");
    expect(audience).toMatchObject({ eligible: 10, skipped: 2, broadcastLimit: 10, broadcastsUsed: 3, planLabel: "Starter" });
    expect(findSegment(audience.segments, "customers")?.id).toBe("seg_1");
    expect(findSegment(audience.segments, "seg_1")?.name).toBe("Customers");
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
