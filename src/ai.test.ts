import { describe, expect, it } from "vitest";
import { applyDigestPatch, buildFallbackIssue } from "./ai.js";
import type { DigestIssue } from "./types.js";

const base: DigestIssue = {
  title: "Weekly digest",
  preheader: "Old preheader",
  intro: "Old intro",
  sourceLabel: "blog.example.com",
  generatedAt: "2026-05-31T00:00:00.000Z",
  items: [
    { title: "One", summary: "First", url: "https://example.com/1" },
    { title: "Two", summary: "Second", url: "https://example.com/2" },
  ],
};

describe("applyDigestPatch", () => {
  it("prefers subject over title and overrides copy", () => {
    const next = applyDigestPatch(base, {
      subject: "Fresh subject",
      preheader: "New preheader",
      intro: "New intro",
    });
    expect(next.title).toBe("Fresh subject");
    expect(next.preheader).toBe("New preheader");
    expect(next.intro).toBe("New intro");
  });

  it("keeps existing values when the patch is empty", () => {
    const next = applyDigestPatch(base, {});
    expect(next.title).toBe("Weekly digest");
    expect(next.preheader).toBe("Old preheader");
    expect(next.items).toHaveLength(2);
  });

  it("patches items positionally without dropping originals", () => {
    const next = applyDigestPatch(base, {
      items: [{ title: "One rewritten" }, {}],
    });
    expect(next.items[0].title).toBe("One rewritten");
    expect(next.items[0].url).toBe("https://example.com/1");
    expect(next.items[1].title).toBe("Two");
  });
});

describe("buildFallbackIssue", () => {
  it("derives a preheader from the first item", () => {
    const issue = buildFallbackIssue("Title", undefined, "src", base.items);
    expect(issue.preheader).toContain("One");
    expect(issue.items).toHaveLength(2);
    expect(issue.intro).toBeTruthy();
  });

  it("handles an empty item list", () => {
    const issue = buildFallbackIssue("Title", "Custom intro", "src", []);
    expect(issue.preheader).toBe("Latest updates.");
    expect(issue.intro).toBe("Custom intro");
  });
});
