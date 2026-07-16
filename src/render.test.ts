import { describe, expect, it } from "vitest";
import { renderHtml, renderText } from "./render.js";
import type { DigestIssue } from "./types.js";

const issue: DigestIssue = {
  title: "Latest updates",
  preheader: "Two posts from the blog.",
  intro: "A short digest.",
  sourceLabel: "Example",
  generatedAt: "2026-05-31T00:00:00.000Z",
  items: [
    {
      title: "First post",
      summary: "A useful summary.",
      url: "https://example.com/first",
      date: "2026-05-30",
    },
  ],
};

describe("renderers", () => {
  it("renders email html", () => {
    const html = renderHtml(issue);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Latest updates");
    expect(html).toContain("https://example.com/first");
  });

  it("renders plain text", () => {
    const text = renderText(issue);
    expect(text).toContain("Latest updates");
    expect(text).toContain("1. First post");
    expect(text).toContain("https://example.com/first");
  });
});
