import { describe, expect, it } from "vitest";
import { cleanText, decodeEntities, excerpt, sortByDateDesc, stripMarkdown, truncateText } from "./utils.js";

describe("decodeEntities", () => {
  it("decodes numeric and named entities", () => {
    expect(decodeEntities("Here&#8217;s &#x2014; &amp; &hellip; caf&eacute;")).toBe("Here’s — & … café");
  });

  it("treats entity names as case-sensitive", () => {
    expect(decodeEntities("&Egrave; &egrave; &AMP; &Amp;")).toBe("\u00c8 \u00e8 & &Amp;");
  });

  it("leaves unknown names and inherited object keys alone", () => {
    expect(decodeEntities("&notanentity; &constructor; &toString;")).toBe("&notanentity; &constructor; &toString;");
  });
});

describe("cleanText", () => {
  it("strips tags, scripts, and comments but keeps a bare less-than sign", () => {
    expect(cleanText("<p>2 < 3 and <b>bold</b></p><script>alert(1)</script><!-- note -->")).toBe("2 < 3 and bold");
  });
});

describe("stripMarkdown", () => {
  it("keeps hyphens and intraword underscores", () => {
    expect(stripMarkdown("A self-hosted run on 2026-05-30 with snake_case_name")).toBe(
      "A self-hosted run on 2026-05-30 with snake_case_name",
    );
  });

  it("removes markup around text", () => {
    expect(stripMarkdown("# Title\n\n- **Bold** and _soft_ [link](https://x.y)\n> quote")).toBe("Title Bold and soft link quote");
  });
});

describe("truncateText and excerpt", () => {
  it("cuts at a word boundary", () => {
    expect(truncateText("one two three four", 9)).toBe("one two...");
    expect(excerpt("short")).toBe("short");
  });
});

describe("sortByDateDesc", () => {
  it("puts items with unparseable dates last instead of scrambling the order", () => {
    const sorted = sortByDateDesc([
      { id: "bad", date: "not a date" },
      { id: "old", date: "2026-01-01" },
      { id: "new", date: "2026-05-01" },
    ]);
    expect(sorted.map((item) => item.id)).toEqual(["new", "old", "bad"]);
  });
});
