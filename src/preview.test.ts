import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { request, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { startPreviewServer } from "./preview.js";

let dir: string;
let server: Server;
let port: number;

function get(pathname: string, headers: Record<string, string> = {}, method = "GET") {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: pathname, method, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "feedletter-preview-"));
  const issue = { title: "Unsent issue", items: [{ title: "Bad link", url: "javascript:alert(1)" }, { title: "Good", url: "https://example.com/a" }] };
  await writeFile(path.join(dir, "issue.json"), JSON.stringify(issue));
  await writeFile(path.join(dir, "email.html"), "<p>email</p>");
  await writeFile(path.join(dir, "email.txt"), "email");
  server = await startPreviewServer({ dir, host: "127.0.0.1", port: 0 });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

describe("preview server", () => {
  it("serves the preview on a loopback Host", async () => {
    const page = await get("/", { host: `127.0.0.1:${port}` });
    expect(page.status).toBe(200);
    expect(page.body).toContain("Unsent issue");
    expect((await get("/issue.json", { host: `localhost:${port}` })).status).toBe(200);
  });

  it("refuses a foreign Host, so a DNS-rebinding page cannot read the unsent issue", async () => {
    const res = await get("/issue.json", { host: `attacker.example:${port}` });
    expect(res.status).toBe(403);
    expect(res.body).not.toContain("Unsent issue");
  });

  it("refuses another site's Origin and anything but GET", async () => {
    expect((await get("/issue.json", { host: `127.0.0.1:${port}`, origin: "https://evil.example" })).status).toBe(403);
    expect((await get("/issue.json", { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` })).status).toBe(200);
    expect((await get("/issue.json", { host: `127.0.0.1:${port}` }, "POST")).status).toBe(405);
  });

  it("sandboxes the email and links only http(s) items", async () => {
    const page = await get("/", { host: `127.0.0.1:${port}` });
    expect(page.body).toMatch(/<iframe id="emailPanel"[^>]*sandbox="[^"]*"/);
    expect(page.body).not.toContain('href="javascript:');
    expect(page.body).toContain('href="https://example.com/a"');
  });
});
