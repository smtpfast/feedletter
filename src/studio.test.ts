import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HistoryStore } from "./history.js";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { bindNeedsHostGuard, isLoopbackHost, rejectForeignRequest, startStudioServer } from "./studio.js";
import { SEND_GUARD_SOURCE } from "./studio-ui.js";

let studio: Server;
let mock: Server;
let base: string;
let mockUrl: string;
let contentDir: string;

// A stand-in for the SMTPfast API so the studio's own fetch has something to hit
// without stubbing global fetch (which the test itself uses to call the studio).
const received: Array<{ method?: string; url?: string; body: unknown }> = [];
const broadcasts = new Map<string, { status: string; subject: string }>();
let broadcastSeq = 0;

function startMock(): Promise<Server> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      received.push({ method: req.method, url: req.url, body });
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.method === "GET" && req.url === "/v1/domains") return json(200, [{ id: "dom_1", domain: "example.com", status: "verified" }]);
      if (req.method === "POST" && req.url === "/v1/emails/batch") {
        const rows = body as Array<{ subject?: string }>;
        const reply = () => json(200, { batch_id: "b1", emails: rows.map((_, i) => ({ id: `email_${i}`, status: "queued" })) });
        // "Slow" lets a test hold a send open while a second one arrives; "Flaky" fails after queueing.
        if (rows[0]?.subject === "Flaky") return json(500, { error: "Internal error" });
        return rows[0]?.subject === "Slow" ? void setTimeout(reply, 300) : reply();
      }
      if (req.method === "GET" && req.url?.startsWith("/v1/broadcasts/audience")) {
        // The exact body of SMTPfast's audience route.
        const segmentId = new URL(req.url, "http://x").searchParams.get("segment_id");
        return json(200, {
          object: "broadcast_audience",
          audience_type: segmentId ? "segment" : "all_contacts",
          segment_id: segmentId,
          audience: { total: 5, eligible: 4, skipped: 1, unsubscribed: 1, suppressed: 0, invalid: 0 },
          domains: [{ id: "dom_1", domain: "example.com" }],
          segments: [{ id: "seg_1", name: "Customers", color: null, contact_count: 2 }],
          package: { tier: "starter", label: "Starter", broadcast_limit: 10, broadcasts_used: 1 },
        });
      }
      if (req.method === "POST" && req.url === "/v1/broadcasts") {
        const id = `bc_${++broadcastSeq}`;
        broadcasts.set(id, { status: "draft", subject: (body as { subject: string }).subject });
        return json(201, { object: "broadcast", id, status: "draft" });
      }
      const broadcastPath = /^\/v1\/broadcasts\/(bc_\d+)(\/send)?$/.exec(req.url ?? "");
      if (broadcastPath && broadcasts.has(broadcastPath[1])) {
        const record = broadcasts.get(broadcastPath[1])!;
        if (req.method === "GET") return json(200, { object: "broadcast", id: broadcastPath[1], status: record.status, recipient_count: 4, recipients: [] });
        if (req.method === "POST" && broadcastPath[2]) {
          record.status = "queued";
          // "Lost" queues the broadcast, then drops the connection before answering.
          if (record.subject === "Lost") return void req.socket.destroy();
          return json(200, { object: "broadcast", id: broadcastPath[1], status: "queued", recipients: 4 });
        }
      }
      json(404, {});
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function post(pathname: string, body: unknown) {
  const res = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  mock = await startMock();
  mockUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;

  contentDir = await mkdtemp(path.join(tmpdir(), "feedletter-studio-"));
  await writeFile(
    path.join(contentDir, "a.md"),
    "---\ntitle: Post A\ndate: 2026-05-02\n---\nBody A",
  );
  await writeFile(
    path.join(contentDir, "b.md"),
    "---\ntitle: Post B\ndate: 2026-05-01\n---\nBody B",
  );

  studio = await startStudioServer({ host: "127.0.0.1", port: 0, history: false });
  base = `http://127.0.0.1:${(studio.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => studio.close(() => r()));
  await new Promise<void>((r) => mock.close(() => r()));
  await rm(contentDir, { recursive: true, force: true });
});

describe("studio server", () => {
  it("serves the studio page", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Feedletter Studio");
    expect(html).toContain('role="dialog"');
    expect(html).toContain('id="viewMobile"');
  });

  it("rejects a cross-origin POST", async () => {
    const res = await fetch(`${base}/api/render`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ items: [] }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects a POST that is not JSON, which a cross-site form could send without a preflight", async () => {
    const res = await fetch(`${base}/api/render`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ items: [] }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects a foreign Host header on a loopback bind (DNS rebinding)", async () => {
    const port = (studio.address() as AddressInfo).port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/", headers: { host: `attacker.example:${port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("loads items from a content directory", async () => {
    const { status, data } = await post("/api/load", { type: "content", content: contentDir, limit: 10 });
    expect(status).toBe(200);
    expect((data.items as unknown[]).length).toBe(2);
    expect((data.items as Array<{ title: string }>)[0].title).toBe("Post A");
  });

  it("renders html and text from a draft", async () => {
    const { status, data } = await post("/api/render", {
      title: "Weekly",
      items: [{ title: "One", url: "https://example.com/1" }],
    });
    expect(status).toBe(200);
    expect(data.html).toContain("Weekly");
    expect(data.html).toContain("Unsubscribe");
    expect(data.text).toContain("One");
  });

  it("verifies a From domain against the account", async () => {
    const { status, data } = await post("/api/verify-domain", {
      apiKey: "k",
      from: "news@example.com",
      baseUrl: mockUrl,
    });
    expect(status).toBe(200);
    expect(data.verified).toBe(true);
  });

  it("sends via the SMTPfast batch endpoint", async () => {
    const { status, data } = await post("/api/send", {
      apiKey: "k",
      from: "news@example.com",
      subject: "Hi",
      recipients: "a@x.com, b@x.com",
      html: "<p>hi</p>",
      baseUrl: mockUrl,
    });
    expect(status).toBe(200);
    expect(data.sent).toBe(2);
    expect(data.failed).toBe(0);
  });

  const draft = { title: "Weekly", preheader: "Two posts", items: [{ title: "One", url: "https://example.com/1" }] };

  it("renders a draft on the server with the unsubscribe placeholder and skips invalid addresses", async () => {
    received.length = 0;
    const { status, data } = await post("/api/send", {
      apiKey: "k",
      from: '"The Weekly" <news@example.com>',
      recipients: "a@x.com, not-an-address",
      draft: { ...draft, unsubscribeUrl: "https://evil.example/u" },
      baseUrl: mockUrl,
    });
    expect(status).toBe(200);
    expect(data).toMatchObject({ sent: 1, failed: 1 });
    const rows = received.find((r) => r.url === "/v1/emails/batch")!.body as Array<{ to: string[]; subject: string; html: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ to: ["a@x.com"], subject: "Weekly" });
    expect(rows[0].html).toContain("{{unsubscribe_url}}");
    expect(rows[0].html).not.toContain("evil.example");
  });

  it("returns the SMTPfast audience", async () => {
    const { status, data } = await post("/api/audience", { apiKey: "k", baseUrl: mockUrl });
    expect(status).toBe(200);
    expect(data).toMatchObject({ eligible: 4, broadcastLimit: 10, broadcastsUsed: 1 });
  });

  it("creates a broadcast draft without sending it", async () => {
    received.length = 0;
    const { status, data } = await post("/api/broadcast", { apiKey: "k", from: "news@example.com", segmentId: "seg_1", draft, baseUrl: mockUrl });
    expect(status).toBe(200);
    expect(data).toMatchObject({ id: "bc_1", status: "draft", url: "https://smtpfa.st/broadcasts/bc_1" });
    const created = received.find((r) => r.url === "/v1/broadcasts")!.body as Record<string, unknown>;
    expect(created).toMatchObject({ subject: "Weekly", preview_text: "Two posts", audience: "segment", segment_id: "seg_1" });
    expect(String(created.html)).toContain("{{unsubscribe_url}}");
    expect(received.some((r) => r.url?.endsWith("/send"))).toBe(false);
  });

  it("creates and sends a broadcast", async () => {
    const { status, data } = await post("/api/broadcast", { apiKey: "k", from: "news@example.com", send: true, draft, baseUrl: mockUrl });
    expect(status).toBe(200);
    expect(data).toMatchObject({ status: "queued", recipients: 4 });
  });

  it("refuses a second send while one is still running", async () => {
    received.length = 0;
    const body = { apiKey: "k", from: "news@example.com", recipients: "a@x.com", draft: { ...draft, title: "Slow" }, baseUrl: mockUrl };
    const [first, second] = await Promise.all([post("/api/send", body), post("/api/send", body)]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(received.filter((r) => r.url === "/v1/emails/batch")).toHaveLength(1);
  });

  it("skips addresses an earlier run of the same send already reached", async () => {
    const body = { apiKey: "k", from: "news@example.com", recipients: "r1@x.com, r2@x.com", draft: { ...draft, title: "Rerun" }, baseUrl: mockUrl };
    expect((await post("/api/send", body)).data).toMatchObject({ sent: 2, alreadySent: 0 });
    received.length = 0;
    expect((await post("/api/send", body)).data).toMatchObject({ sent: 0, alreadySent: 2, failed: 0 });
    expect(received.some((r) => r.url === "/v1/emails/batch")).toBe(false);
  });

  it("recovers a broadcast whose send answer was lost, and never sends it twice", async () => {
    received.length = 0;
    const body = { apiKey: "k", from: "news@example.com", send: true, draft: { ...draft, title: "Lost" }, baseUrl: mockUrl };
    const first = await post("/api/broadcast", body);
    expect(first.status).toBe(200);
    expect(first.data).toMatchObject({ status: "queued", recovered: true });

    const retry = await post("/api/broadcast", body);
    expect(retry.status).toBe(409);
    expect(String(retry.data.error)).toMatch(/already went out/);
    expect(received.filter((r) => r.method === "POST" && r.url === "/v1/broadcasts")).toHaveLength(1);
    expect(received.filter((r) => r.url?.endsWith("/send"))).toHaveLength(1);
  });

  it("stops instead of creating a new campaign when the saved broadcast was canceled", async () => {
    received.length = 0;
    const body = { apiKey: "k", from: "news@example.com", draft: { ...draft, title: "Canceled" }, baseUrl: mockUrl };
    const saved = await post("/api/broadcast", body);
    broadcasts.get(String(saved.data.id))!.status = "canceled";

    const retry = await post("/api/broadcast", { ...body, send: true });
    expect(retry.status).toBe(409);
    expect(String(retry.data.error)).toMatch(/was canceled; some contacts may already have it/);
    expect(received.filter((r) => r.method === "POST" && r.url === "/v1/broadcasts")).toHaveLength(1);
    expect(received.some((r) => r.url?.endsWith("/send"))).toBe(false);
  });

  it("reports a 5xx batch as uncertain and skips those addresses on a rerun", async () => {
    const body = { apiKey: "k", from: "news@example.com", recipients: "f1@x.com", draft: { ...draft, title: "Flaky" }, baseUrl: mockUrl };
    expect((await post("/api/send", body)).data).toMatchObject({ sent: 0, uncertain: 1, failed: 0 });
    received.length = 0;
    expect((await post("/api/send", body)).data).toMatchObject({ sent: 0, uncertain: 1 });
    expect(received.some((r) => r.url === "/v1/emails/batch")).toBe(false);
  });

  it("refuses to send while another process holds the history lock", async () => {
    const historyDb = path.join(contentDir, "locked.sqlite");
    const second = await startStudioServer({ host: "127.0.0.1", port: 0, historyDb });
    const other = await HistoryStore.open(historyDb);
    let release!: () => void;
    const holding = other.exclusive(() => new Promise<void>((resolve) => (release = resolve)));
    try {
      const res = await fetch(`http://127.0.0.1:${(second.address() as AddressInfo).port}/api/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "k", from: "news@example.com", recipients: "l@x.com", draft: { ...draft, title: "Locked" }, baseUrl: mockUrl }),
      });
      expect(res.status).toBe(409);
      expect(String(((await res.json()) as { error: string }).error)).toMatch(/Another feedletter send is using/);
    } finally {
      release();
      await holding;
      other.close();
      await new Promise<void>((r) => second.close(() => r()));
    }
  });

  it("explains a failed audience lookup", async () => {
    const { status, data } = await post("/api/audience", { apiKey: "k", baseUrl: `${mockUrl}/missing` });
    expect(status).toBe(502);
    expect(String(data.error)).toMatch(/Could not check the SMTPfast audience/);
  });

  it("rejects a send with no recipients", async () => {
    const { status, data } = await post("/api/send", {
      apiKey: "k",
      from: "news@example.com",
      subject: "Hi",
      recipients: "",
      html: "<p>hi</p>",
      baseUrl: mockUrl,
    });
    expect(status).toBe(400);
    expect(data.error).toBeTruthy();
  });
});

describe("studio request guard", () => {
  const fake = (headers: Record<string, string>, method = "GET") => ({ headers, method }) as unknown as IncomingMessage;

  it("recognises loopback binds in any case and spelling", () => {
    for (const host of ["127.0.0.1", "127.0.0.2", "127.255.0.9", "localhost", "LOCALHOST", "LocalHost", "::1", "[::1]", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1"]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of ["0.0.0.0", "::", "192.168.1.5", "128.0.0.1", "localhost.evil.example", "evil.example"]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });

  it("applies the Host check to every bind that resolves to loopback, and fails closed", async () => {
    // A fixed resolver keeps the test offline; dns.lookup("127.1") gives 127.0.0.1 on Node.
    const resolver = (table: Record<string, string[]>) => async (host: string) => {
      if (table[host]) return table[host].map((address) => ({ address }));
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    };
    const dns = resolver({ "127.1": ["127.0.0.1"], "studio.lan": ["192.168.1.5"], "both.lan": ["192.168.1.5", "::1"] });
    for (const bind of ["LOCALHOST", "127.0.0.2", "::1", "0:0:0:0:0:0:0:1", "127.1", "both.lan", "no-such-host.invalid"]) {
      expect(await bindNeedsHostGuard(bind, dns), bind).toBe(true);
    }
    for (const bind of ["0.0.0.0", "::", "192.168.1.5", "studio.lan"]) {
      expect(await bindNeedsHostGuard(bind, dns), bind).toBe(false);
    }
  });

  it("rejects a foreign Host when the guard applies", () => {
    expect(rejectForeignRequest(fake({ host: "attacker.example:4180" }), true)).toBe("Unknown host.");
    expect(rejectForeignRequest(fake({ host: "127.0.0.2:4180" }), true)).toBeUndefined();
    expect(rejectForeignRequest(fake({ host: "LOCALHOST:4180" }), true)).toBeUndefined();
    expect(rejectForeignRequest(fake({ host: "[::1]:4180" }), true)).toBeUndefined();
  });

  it("accepts any Host on an explicit non-loopback bind but still checks Origin", () => {
    expect(rejectForeignRequest(fake({ host: "192.168.1.5:4180" }), false)).toBeUndefined();
    const crossSite = fake({ host: "192.168.1.5:4180", origin: "https://evil.example", "content-type": "application/json" }, "POST");
    expect(rejectForeignRequest(crossSite, false)).toMatch(/Cross-origin/);
  });
});

describe("studio send guard", () => {
  type Guard = {
    press(action: string, token: string): "armed" | "confirmed" | "busy";
    disarm(): boolean;
    isArmed(action: string): boolean;
    start(action: string): boolean;
    finish(): void;
    busy(): string | null;
  };
  const { createSendGuard, createAudienceTracker } = new Function(
    `${SEND_GUARD_SOURCE}\nreturn { createSendGuard, createAudienceTracker };`,
  )() as {
    createSendGuard: () => Guard;
    createAudienceTracker: () => {
      change(): number;
      begin(): number;
      settle(token: number, value: unknown): boolean;
      fail(token: number): boolean;
      current(): unknown;
      loading(): boolean;
      version(): number;
    };
  };

  it("ignores an audience answer that arrives after the key or segment changed", () => {
    const audience = createAudienceTracker();
    const oldKeyLookup = audience.begin();
    audience.change();
    // The answer for the old key lands during the debounce for the new key.
    expect(audience.settle(oldKeyLookup, { eligible: 1261 })).toBe(false);
    expect(audience.current()).toBeNull();
    expect(audience.loading()).toBe(false);

    const lookup = audience.begin();
    expect(audience.settle(lookup, { eligible: 96 })).toBe(true);
    expect(audience.current()).toEqual({ eligible: 96 });
  });

  it("needs two presses for the same audience", () => {
    const guard = createSendGuard();
    expect(guard.press("broadcast", "contacts:1")).toBe("armed");
    expect(guard.press("broadcast", "contacts:1")).toBe("confirmed");
  });

  it("re-arms instead of sending when the audience changed during confirmation", () => {
    const guard = createSendGuard();
    expect(guard.press("broadcast", "contacts:1")).toBe("armed");
    // The page bumps the audience token and disarms when the key or segment changes.
    expect(guard.press("broadcast", "contacts:2")).toBe("armed");
    expect(guard.disarm()).toBe(true);
    expect(guard.press("broadcast", "contacts:2")).toBe("armed");
  });

  it("refuses a second send while one is in flight", () => {
    const guard = createSendGuard();
    guard.press("list", "list:a@x.com");
    expect(guard.press("list", "list:a@x.com")).toBe("confirmed");
    expect(guard.start("list")).toBe(true);
    expect(guard.start("list")).toBe(false);
    expect(guard.press("broadcast", "contacts:1")).toBe("busy");
    expect(guard.busy()).toBe("list");
    guard.finish();
    expect(guard.start("broadcast")).toBe(true);
  });
});

