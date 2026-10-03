import { afterEach, describe, expect, it } from "vitest";
import { decodeFeedBody, discoverFeedUrl, loadRssFeed } from "./rss.js";

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

type Route = { body: string | Uint8Array; status?: number; contentType?: string };
const realFetch = globalThis.fetch;
const calls: Array<{ url: string; init?: RequestInit }> = [];

// Plain global swap instead of vi.stubGlobal, so the suite also runs under `bun test`.
function serve(routes: Record<string, Route> | Route) {
  calls.length = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = "body" in routes ? (routes as Route) : (routes as Record<string, Route>)[url];
    if (!route) return new Response("not found", { status: 404, statusText: "Not Found" });
    const status = route.status ?? 200;
    return new Response(status === 204 ? null : route.body, {
      status,
      statusText: status === 200 ? "OK" : "Error",
      headers: { "content-type": route.contentType ?? "application/rss+xml" },
    });
  }) as typeof fetch;
}

function mockFetch(body: string, ok = true) {
  serve({ body, status: ok ? 200 : 500 });
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("loadRssFeed", () => {
  it("parses RSS items, newest first, and sets a User-Agent", async () => {
    mockFetch(rssXml);

    const items = await loadRssFeed({ url: "https://example.com/feed.xml", limit: 5 });

    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("Newer post");
    expect(items[0].author).toBe("Jane");
    expect(items[1].title).toBe("Older post");

    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["user-agent"]).toContain("feedletter");
  });

  it("respects the limit", async () => {
    mockFetch(rssXml);
    const items = await loadRssFeed({ url: "https://example.com/feed.xml", limit: 1 });
    expect(items).toHaveLength(1);
  });

  it("parses Atom entries", async () => {
    mockFetch(atomXml);
    const items = await loadRssFeed({ url: "https://example.com/atom.xml", limit: 5 });
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Atom post");
    expect(items[0].url).toBe("https://example.com/atom-1");
    expect(items[0].author).toBe("Sam");
  });

  it("throws a helpful error on a non-ok response", async () => {
    mockFetch("", false);
    await expect(loadRssFeed({ url: "https://example.com/feed.xml", limit: 5 })).rejects.toThrow(/500/);
  });

  it("decodes HTML entities in titles and summaries", async () => {
    mockFetch(`<rss version="2.0"><channel><item>
      <title><![CDATA[Postgres &amp; Redis &#8212; notes]]></title>
      <link>https://example.com/a</link>
      <description><![CDATA[<p>Here&#8217;s what broke &hellip; and 2 &lt; 3</p>]]></description>
    </item></channel></rss>`);
    const [item] = await loadRssFeed({ url: "https://example.com/feed.xml", limit: 5 });
    expect(item.title).toBe("Postgres & Redis \u2014 notes");
    expect(item.summary).toBe("Here\u2019s what broke \u2026 and 2 < 3");
  });

  it("keeps angle brackets that a title spells out", async () => {
    mockFetch(`<rss version="2.0"><channel><item><title>Using &lt;template&gt; in HTML</title><link>https://example.com/t</link></item></channel></rss>`);
    const [item] = await loadRssFeed({ url: "https://example.com/feed.xml", limit: 5 });
    expect(item.title).toBe("Using <template> in HTML");
  });

  it("shortens a full-text body into a card-sized summary", async () => {
    const body = "word ".repeat(400);
    mockFetch(`<rss version="2.0"><channel><item><title>Long</title><link>https://example.com/l</link>
      <content:encoded><![CDATA[<p>${body}</p>]]></content:encoded></item></channel></rss>`);
    const [item] = await loadRssFeed({ url: "https://example.com/feed.xml", limit: 5 });
    expect(item.summary!.length).toBeLessThanOrEqual(303);
    expect(item.summary!.endsWith("...")).toBe(true);
    expect(item.content).toContain("word word");
  });

  it("only uses http(s) links, resolving relative ones against the feed", async () => {
    mockFetch(`<rss version="2.0"><channel>
      <item><title>Tag guid</title><guid isPermaLink="false">tag:example.com,2026:1</guid></item>
      <item><title>Relative</title><link>/posts/relative</link></item>
      <item><title>Guid URL</title><guid>https://example.com/from-guid</guid></item>
    </channel></rss>`);
    const items = await loadRssFeed({ url: "https://example.com/blog/feed.xml", limit: 5 });
    expect(items.find((i) => i.title === "Tag guid")!.url).toBeUndefined();
    expect(items.find((i) => i.title === "Relative")!.url).toBe("https://example.com/posts/relative");
    expect(items.find((i) => i.title === "Guid URL")!.url).toBe("https://example.com/from-guid");
  });

  it("decodes a Latin-1 feed from its XML declaration", async () => {
    const latin1 = Uint8Array.from(
      Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><rss version="2.0"><channel><item><title>Caf\xe9</title><link>https://example.com/c</link></item></channel></rss>', "latin1"),
    );
    serve({ body: latin1, contentType: "application/xml" });
    const [item] = await loadRssFeed({ url: "https://example.com/feed.xml", limit: 5 });
    expect(item.title).toBe("Caf\u00e9");
  });

  it("prefers the Content-Type charset over the XML declaration", () => {
    const bytes = Uint8Array.from(Buffer.from('<?xml version="1.0" encoding="utf-8"?><t>\xe9</t>', "latin1"));
    expect(decodeFeedBody(bytes, "text/xml; charset=ISO-8859-1")).toContain("\u00e9");
  });

  it("returns no items for a valid feed with an empty channel", async () => {
    mockFetch(`<rss version="2.0"><channel><title>Empty</title></channel></rss>`);
    await expect(loadRssFeed({ url: "https://example.com/feed.xml", limit: 5 })).resolves.toEqual([]);
  });

  it("follows the feed a web page advertises", async () => {
    serve({
      "https://blog.example.com/": {
        body: '<!doctype html><html><head><link rel="alternate" type="application/rss+xml" href="/rss.xml"></head></html>',
        contentType: "text/html; charset=utf-8",
      },
      "https://blog.example.com/rss.xml": { body: rssXml },
    });
    const items = await loadRssFeed({ url: "blog.example.com/", limit: 5 });
    expect(items).toHaveLength(2);
    expect(items[0].source).toBe("https://blog.example.com/rss.xml");
  });

  it("still parses a feed served as text/html", async () => {
    serve({ body: rssXml, contentType: "text/html; charset=utf-8" });
    await expect(loadRssFeed({ url: "https://example.com/feed", limit: 5 })).resolves.toHaveLength(2);
  });

  it("explains when a web page has no feed", async () => {
    serve({ body: "<!doctype html><html><head></head></html>", contentType: "text/html" });
    await expect(loadRssFeed({ url: "https://example.com/", limit: 5 })).rejects.toThrow(/web page, not a feed/);
  });

  it("parses RSS 1.0 (RDF) feeds", async () => {
    mockFetch(`<?xml version="1.0"?>
      <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
        <channel rdf:about="https://example.com/"><title>RDF</title></channel>
        <item rdf:about="https://example.com/r1"><title>RDF post</title><link>https://example.com/r1</link><dc:date>2026-05-31T10:00:00Z</dc:date><dc:creator>Ann</dc:creator></item>
      </rdf:RDF>`);
    const [item] = await loadRssFeed({ url: "https://example.com/index.rdf", limit: 5 });
    expect(item.title).toBe("RDF post");
    expect(item.url).toBe("https://example.com/r1");
    expect(item.author).toBe("Ann");
    expect(item.date).toBe("2026-05-31T10:00:00Z");
  });

  it("uses the Atom published date and the alternate link", async () => {
    mockFetch(`<feed xmlns="http://www.w3.org/2005/Atom"><entry>
      <title type="html">A &amp;amp; B</title>
      <link rel="self" href="https://example.com/entry.atom" />
      <link href="https://example.com/a-and-b" />
      <published>2026-05-01T10:00:00Z</published>
      <updated>2026-05-31T10:00:00Z</updated>
    </entry></feed>`);
    const [item] = await loadRssFeed({ url: "https://example.com/atom.xml", limit: 5 });
    expect(item.title).toBe("A & B");
    expect(item.url).toBe("https://example.com/a-and-b");
    expect(item.date).toBe("2026-05-01T10:00:00Z");
  });
});

describe("discoverFeedUrl", () => {
  it("handles attribute order, quotes, and Atom feeds", () => {
    const html = `<link href='https://cdn.example.com/x.css' rel=stylesheet><link type="application/atom+xml" href="feed.atom" rel="alternate">`;
    expect(discoverFeedUrl(html, "https://example.com/blog/")).toBe("https://example.com/blog/feed.atom");
  });
});
