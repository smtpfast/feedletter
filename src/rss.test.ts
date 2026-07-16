import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRssFeed } from "./rss.js";

const rssXml = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Example</title>
    <item>
      <title>Newer post</title>
      <link>https://example.com/newer</link>
      <description>Newer summary</description>
      <pubDate>Sat, 31 May 2026 10:00:00 GMT</pubDate>
      <dc:creator>Jane</dc:creator>
    </item>
    <item>
      <title>Older post</title>
      <link>https://example.com/older</link>
      <description>Older summary</description>
      <pubDate>Fri, 30 May 2026 10:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

const atomXml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Example</title>
  <entry>
    <title>Atom post</title>
    <link rel="alternate" href="https://example.com/atom-1" />
    <summary>Atom summary</summary>
    <updated>2026-05-31T10:00:00Z</updated>
    <author><name>Sam</name></author>
  </entry>
</feed>`;

function mockFetch(body: string, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? "OK" : "Error",
    text: () => Promise.resolve(body),
  } as Response);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadRssFeed", () => {
  it("parses RSS items, newest first, and sets a User-Agent", async () => {
    const fetchMock = mockFetch(rssXml);
    vi.stubGlobal("fetch", fetchMock);

    const items = await loadRssFeed({ url: "https://example.com/feed.xml", limit: 5 });

    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("Newer post");
    expect(items[0].author).toBe("Jane");
    expect(items[1].title).toBe("Older post");

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["user-agent"]).toContain("feedletter");
  });

  it("respects the limit", async () => {
    vi.stubGlobal("fetch", mockFetch(rssXml));
    const items = await loadRssFeed({ url: "https://example.com/feed.xml", limit: 1 });
    expect(items).toHaveLength(1);
  });

  it("parses Atom entries", async () => {
    vi.stubGlobal("fetch", mockFetch(atomXml));
    const items = await loadRssFeed({ url: "https://example.com/atom.xml", limit: 5 });
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Atom post");
    expect(items[0].url).toBe("https://example.com/atom-1");
    expect(items[0].author).toBe("Sam");
  });

  it("throws a helpful error on a non-ok response", async () => {
    vi.stubGlobal("fetch", mockFetch("", false));
    await expect(loadRssFeed({ url: "https://example.com/feed.xml", limit: 5 })).rejects.toThrow(/500/);
  });
});
