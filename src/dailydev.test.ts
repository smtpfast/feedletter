import { afterEach, describe, expect, it } from "vitest";
import { dailyDevFeedLabel, loadDailyDevFeed, parseDailyDevFeed } from "./dailydev.js";

const realFetch = globalThis.fetch;
const calls: Array<{ url: URL; init?: RequestInit }> = [];

function serve(status: number, body: unknown, headers: Record<string, string> = {}) {
  calls.length = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init });
    const text = body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "content-type": "application/json", ...headers } });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

const post = (over: Record<string, unknown> = {}) => ({
  id: "D2ornCubs",
  title: "A Missing Binary Turned a Kubernetes Liveness Probe Into a Restart Loop",
  url: "https://example.com/article",
  summary: "The probe used pgrep, which the slim image did not have.",
  image: "https://media.daily.dev/image.png",
  publishedAt: "2026-09-25T10:42:11.000Z",
  createdAt: "2026-09-25T11:39:15.045Z",
  commentsPermalink: "https://daily.dev/posts/a-missing-binary-d2orncubs",
  source: { name: "Cloud Native Now" },
  author: null,
  ...over,
});

describe("parseDailyDevFeed", () => {
  it("reads every feed form", () => {
    expect(parseDailyDevFeed("foryou")).toEqual({ kind: "foryou" });
    expect(parseDailyDevFeed("Popular")).toEqual({ kind: "popular" });
    expect(parseDailyDevFeed("popular:kubernetes,docker")).toEqual({ kind: "popular", tags: "kubernetes,docker" });
    expect(parseDailyDevFeed("discussed:rust")).toEqual({ kind: "discussed", tag: "rust" });
    expect(parseDailyDevFeed("bookmarks")).toEqual({ kind: "bookmarks" });
    expect(parseDailyDevFeed("tag:terraform")).toEqual({ kind: "tag", tag: "terraform" });
    expect(parseDailyDevFeed("search: postgres replication ")).toEqual({ kind: "search", query: "postgres replication" });
  });

  it("refuses unknown feeds and missing values", () => {
    expect(() => parseDailyDevFeed("trending")).toThrow(/Unknown daily.dev feed/);
    expect(() => parseDailyDevFeed("tag:")).toThrow(/Give a tag/);
    expect(() => parseDailyDevFeed("search")).toThrow(/Give search words/);
    expect(() => parseDailyDevFeed("bookmarks:x")).toThrow(/Unknown daily.dev feed/);
  });

  it("labels feeds for the email", () => {
    expect(dailyDevFeedLabel({ kind: "popular", tags: "kubernetes, docker" })).toBe("Popular on daily.dev: kubernetes, docker");
    expect(dailyDevFeedLabel({ kind: "bookmarks" })).toBe("daily.dev bookmarks");
  });
});

describe("loadDailyDevFeed", () => {
  it("calls the right endpoint with the token, and asks for extra posts", async () => {
    serve(200, { data: [post()] });
    await loadDailyDevFeed({ feed: { kind: "popular", tags: "kubernetes" }, limit: 5, token: "dda_test" });
    expect(calls[0].url.origin + calls[0].url.pathname).toBe("https://api.daily.dev/public/v1/feeds/popular");
    expect(calls[0].url.searchParams.get("tags")).toBe("kubernetes");
    expect(calls[0].url.searchParams.get("limit")).toBe("15");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer dda_test");
    expect(calls[0].init?.redirect).toBe("manual");
  });

  it("maps each feed to its endpoint", async () => {
    const cases: Array<[Parameters<typeof loadDailyDevFeed>[0]["feed"], string, Record<string, string>]> = [
      [{ kind: "foryou" }, "/feeds/foryou", {}],
      [{ kind: "discussed", tag: "rust" }, "/feeds/discussed", { period: "7", tag: "rust" }],
      [{ kind: "bookmarks" }, "/bookmarks/", {}],
      [{ kind: "tag", tag: "c#" }, "/feeds/tag/c%23", {}],
      [{ kind: "search", query: "pgvector" }, "/search/posts", { q: "pgvector", time: "week" }],
    ];
    for (const [feed, path, params] of cases) {
      serve(200, { data: [] });
      await loadDailyDevFeed({ feed, limit: 45, token: "dda_test" });
      expect(calls[0].url.pathname).toBe(`/public/v1${path}`);
      expect(calls[0].url.searchParams.get("limit")).toBe("50");
      for (const [key, value] of Object.entries(params)) expect(calls[0].url.searchParams.get(key)).toBe(value);
    }
  });

  it("turns posts into items, drops untitled shares, and keeps the limit", async () => {
    serve(200, {
      data: [
        post({ title: "", url: null, summary: null }),
        post({ summary: "x ".repeat(400), author: { name: "Jane" } }),
        post({ id: "two", title: "Second" }),
        post({ id: "three", title: "Third" }),
      ],
    });
    const items = await loadDailyDevFeed({ feed: { kind: "foryou" }, limit: 2, token: "dda_test" });
    expect(items.map((i) => i.title)).toEqual(["A Missing Binary Turned a Kubernetes Liveness Probe Into a Restart Loop", "Second"]);
    expect(items[0]).toMatchObject({
      url: "https://example.com/article",
      date: "2026-09-25T10:42:11.000Z",
      author: "Jane",
      source: "Cloud Native Now",
      image: "https://media.daily.dev/image.png",
    });
    expect(items[0].summary!.length).toBeLessThanOrEqual(303);
  });

  it("links to the discussion when asked, and falls back when a post has no article", async () => {
    serve(200, { data: [post(), post({ url: null })] });
    const discussion = await loadDailyDevFeed({ feed: { kind: "foryou" }, limit: 5, token: "dda_test", link: "discussion" });
    expect(discussion[0].url).toBe("https://daily.dev/posts/a-missing-binary-d2orncubs");

    serve(200, { data: [post({ url: null })] });
    const article = await loadDailyDevFeed({ feed: { kind: "foryou" }, limit: 5, token: "dda_test" });
    expect(article[0].url).toBe("https://daily.dev/posts/a-missing-binary-d2orncubs");
  });

  it("explains a missing or rejected token", async () => {
    serve(200, { data: [] });
    await expect(loadDailyDevFeed({ feed: { kind: "foryou" }, limit: 5, token: " " })).rejects.toThrow(/Set DAILY_DEV_TOKEN/);
    expect(calls).toHaveLength(0);

    serve(401, { error: "unauthorized" });
    await expect(loadDailyDevFeed({ feed: { kind: "foryou" }, limit: 5, token: "bad" })).rejects.toThrow(/did not accept the token/);
  });

  it("does not follow a redirect, and reports the rate limit and bad bodies", async () => {
    serve(302, undefined, { location: "https://elsewhere.example/" });
    await expect(loadDailyDevFeed({ feed: { kind: "foryou" }, limit: 5, token: "dda_test" })).rejects.toThrow(/redirect/);
    expect(calls).toHaveLength(1);

    serve(429, {}, { "x-ratelimit-reset": "42" });
    await expect(loadDailyDevFeed({ feed: { kind: "foryou" }, limit: 5, token: "dda_test" })).rejects.toThrow(/Try again in 42s/);

    serve(200, "<html>proxy</html>");
    await expect(loadDailyDevFeed({ feed: { kind: "foryou" }, limit: 5, token: "dda_test" })).rejects.toThrow(/not with a list of posts/);
  });
});

describe("token safety", () => {
  it("refuses a token with whitespace or control characters before any request", async () => {
    serve(200, { data: [] });
    await expect(loadDailyDevFeed({ feed: { kind: "foryou" }, limit: 5, token: "dda_ab\ncd" })).rejects.toThrow(/characters that a token cannot have/);
    await expect(loadDailyDevFeed({ feed: { kind: "foryou" }, limit: 5, token: "dda ab" })).rejects.toThrow(/characters that a token cannot have/);
    expect(calls).toHaveLength(0);
  });

  it("never puts the fetch error text in its own error", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Headers.append: Bearer dda_secret is an invalid header value", { cause: { code: "ERR_INVALID_CHAR" } });
    }) as typeof fetch;
    const error = await loadDailyDevFeed({ feed: { kind: "foryou" }, limit: 5, token: "dda_secret" }).catch((e: Error) => e);
    expect(String(error)).toContain("Could not reach daily.dev (ERR_INVALID_CHAR)");
    expect(String(error)).not.toContain("dda_secret");
  });
});
