import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { bindNeedsHostGuard, isLoopbackHost, rejectForeignRequest, startStudioServer } from "./studio.js";

let studio: Server;
let mock: Server;
let base: string;
let mockUrl: string;
let contentDir: string;

// A stand-in for the SMTPfast API so the studio's own fetch has something to hit
// without stubbing global fetch (which the test itself uses to call the studio).
function startMock(): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/domains") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ id: "dom_1", domain: "example.com", status: "verified" }]));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/emails") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "email_test" }));
      return;
    }
    res.writeHead(404);
    res.end("{}");
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

  it("sends via the SMTPfast endpoint", async () => {
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
    for (const bind of ["LOCALHOST", "127.0.0.2", "127.1", "::1", "0:0:0:0:0:0:0:1", "no-such-host.invalid"]) {
      expect(await bindNeedsHostGuard(bind), bind).toBe(true);
    }
    for (const bind of ["0.0.0.0", "::", "192.168.1.5"]) {
      expect(await bindNeedsHostGuard(bind), bind).toBe(false);
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

