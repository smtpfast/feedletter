import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRecipients, verifyFromDomain } from "./smtpfast.js";

afterEach(() => vi.restoreAllMocks());

function mockDomains(domains: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok,
      status: ok ? 200 : 401,
      statusText: ok ? "OK" : "Unauthorized",
      text: () => Promise.resolve(JSON.stringify(domains)),
      json: () => Promise.resolve(domains),
    } as Response),
  );
}

describe("parseRecipients", () => {
  it("splits on commas, spaces, semicolons, and newlines", () => {
    expect(parseRecipients("a@x.com, b@x.com\n c@x.com;d@x.com")).toEqual([
      "a@x.com",
      "b@x.com",
      "c@x.com",
      "d@x.com",
    ]);
  });

  it("drops empties", () => {
    expect(parseRecipients("  , ,a@x.com,")).toEqual(["a@x.com"]);
  });
});

describe("verifyFromDomain", () => {
  it("reports a verified domain", async () => {
    mockDomains([{ domain: "mail.example.com", status: "verified" }]);
    const check = await verifyFromDomain({ apiKey: "k" }, "news@mail.example.com");
    expect(check).toEqual({ found: true, verified: true, status: "verified" });
  });

  it("reports a found but unverified domain", async () => {
    mockDomains([{ domain: "example.com", status: "pending" }]);
    const check = await verifyFromDomain({ apiKey: "k" }, "hi@example.com");
    expect(check.found).toBe(true);
    expect(check.verified).toBe(false);
  });

  it("reports a domain not on the account", async () => {
    mockDomains([{ domain: "other.com", status: "verified" }]);
    const check = await verifyFromDomain({ apiKey: "k" }, "hi@example.com");
    expect(check).toEqual({ found: false, verified: false });
  });

  it("throws on an auth error", async () => {
    mockDomains({ error: "unauthorized" }, false);
    await expect(verifyFromDomain({ apiKey: "bad" }, "hi@example.com")).rejects.toThrow(/401/);
  });
});
