import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { startStudioServer } from "./studio.js";

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
    expect(await res.text()).toContain("Feedletter Studio");
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
