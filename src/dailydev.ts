import type { SourceItem } from "./types.js";
import { cleanText, isHttpUrl, truncateText } from "./utils.js";

export const DAILY_DEV_API_URL = "https://api.daily.dev/public/v1";
export const DAILY_DEV_TOKEN_URL = "https://daily.dev/settings/api";

const DEFAULT_TIMEOUT_MS = 15000;
const SUMMARY_MAX_LENGTH = 300;
/** The most posts the API returns in one request. */
const MAX_LIMIT = 50;
const USER_AGENT = "feedletter (+https://github.com/smtpfast/feedletter)";

export type DailyDevFeed =
  | { kind: "foryou" }
  | { kind: "popular"; tags?: string }
  | { kind: "discussed"; tag?: string }
  | { kind: "bookmarks" }
  | { kind: "tag"; tag: string }
  | { kind: "search"; query: string };

export type DailyDevLink = "article" | "discussion";

export const DAILY_DEV_FEEDS = "foryou, popular[:tags], discussed[:tag], bookmarks, tag:<tag> or search:<words>";

/** Reads "popular", "popular:kubernetes,docker", "tag:rust", "search:postgres replication" and so on. */
export function parseDailyDevFeed(spec: string): DailyDevFeed {
  const trimmed = spec.trim();
  const colon = trimmed.indexOf(":");
  const name = (colon === -1 ? trimmed : trimmed.slice(0, colon)).toLowerCase();
  const value = colon === -1 ? "" : trimmed.slice(colon + 1).trim();

  switch (name) {
    case "foryou":
    case "bookmarks":
      if (value) break;
      return { kind: name as "foryou" | "bookmarks" };
    case "popular":
      return value ? { kind: "popular", tags: value } : { kind: "popular" };
    case "discussed":
      return value ? { kind: "discussed", tag: value } : { kind: "discussed" };
    case "tag":
      if (!value) throw new Error("Give a tag, for example --dailydev tag:kubernetes.");
      return { kind: "tag", tag: value };
    case "search":
      if (!value) throw new Error("Give search words, for example --dailydev search:postgres.");
      return { kind: "search", query: value };
  }
  throw new Error(`Unknown daily.dev feed "${spec}". Use one of: ${DAILY_DEV_FEEDS}.`);
}

export function dailyDevFeedLabel(feed: DailyDevFeed): string {
  switch (feed.kind) {
    case "foryou":
      return "daily.dev";
    case "popular":
      return feed.tags ? `Popular on daily.dev: ${feed.tags.split(",").map((t) => t.trim()).join(", ")}` : "Popular on daily.dev";
    case "discussed":
      return feed.tag ? `Discussed on daily.dev: ${feed.tag}` : "Discussed on daily.dev";
    case "bookmarks":
      return "daily.dev bookmarks";
    case "tag":
      return `daily.dev: ${feed.tag}`;
    case "search":
      return `daily.dev: ${feed.query}`;
  }
}

function requestFor(feed: DailyDevFeed, limit: number): { path: string; query: Record<string, string | undefined> } {
  const base = { limit: String(limit) };
  switch (feed.kind) {
    case "foryou":
      return { path: "/feeds/foryou", query: base };
    case "popular":
      return { path: "/feeds/popular", query: { ...base, tags: feed.tags } };
    case "discussed":
      return { path: "/feeds/discussed", query: { ...base, period: "7", tag: feed.tag } };
    case "bookmarks":
      return { path: "/bookmarks/", query: base };
    case "tag":
      return { path: `/feeds/tag/${encodeURIComponent(feed.tag)}`, query: base };
    case "search":
      // A newsletter wants recent posts, not the best match from five years ago.
      return { path: "/search/posts", query: { ...base, q: feed.query, time: "week" } };
  }
}

interface DailyDevPost {
  id: string;
  title?: string;
  url?: string | null;
  summary?: string | null;
  image?: string | null;
  publishedAt?: string | null;
  createdAt?: string;
  commentsPermalink?: string;
  source?: { name?: string } | null;
  author?: { name?: string } | null;
}

export interface LoadDailyDevOptions {
  feed: DailyDevFeed;
  limit: number;
  token: string;
  /** Where each item links: the original article (the default) or the daily.dev discussion. */
  link?: DailyDevLink;
  /** Tests point this at a local server. The CLI and the studio never set it from user input. */
  apiUrl?: string;
  timeoutMs?: number;
}

export async function loadDailyDevFeed(options: LoadDailyDevOptions): Promise<SourceItem[]> {
  const token = options.token.trim();
  if (!token) throw new Error(`Set DAILY_DEV_TOKEN to a daily.dev personal access token. Create one at ${DAILY_DEV_TOKEN_URL}.`);
  // A token with spaces or control characters makes fetch fail with an error that quotes the header.
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new Error(`DAILY_DEV_TOKEN has characters that a token cannot have. Copy it again from ${DAILY_DEV_TOKEN_URL}.`);
  }

  const limit = Math.max(1, Math.floor(options.limit));
  // Ask for extra posts, because shares without a title are dropped below.
  const { path, query } = requestFor(options.feed, Math.min(limit + 10, MAX_LIMIT));
  const url = new URL((options.apiUrl ?? DAILY_DEV_API_URL).replace(/\/$/, "") + path);
  for (const [key, value] of Object.entries(query)) if (value) url.searchParams.set(key, value);

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": USER_AGENT },
      // A redirect would carry the token to another URL, so it is never followed.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await response.text();
  } catch (error) {
    // Only a fixed reason or an error code, never the error text: the studio shows this in the browser.
    const code = (error as { cause?: { code?: unknown } })?.cause?.code;
    const reason =
      error instanceof Error && error.name === "TimeoutError"
        ? `no answer after ${timeoutMs / 1000}s`
        : typeof code === "string" && /^[A-Z0-9_]+$/.test(code)
          ? code
          : "network error";
    throw new Error(`Could not reach daily.dev (${reason}).`);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new Error(`daily.dev answered with a redirect (${response.status}). Feedletter does not follow it, so the token stays with daily.dev.`);
  }
  if (response.status === 401) {
    throw new Error(`daily.dev did not accept the token. Create a new one at ${DAILY_DEV_TOKEN_URL} and set DAILY_DEV_TOKEN.`);
  }
  if (response.status === 429) {
    const reset = response.headers.get("x-ratelimit-reset");
    throw new Error(`The daily.dev rate limit is reached.${reset ? ` Try again in ${reset}s.` : " Try again in a minute."}`);
  }
  if (!response.ok) throw new Error(`daily.dev answered ${response.status} for ${path}.`);

  let posts: DailyDevPost[];
  try {
    const data = JSON.parse(text) as { data?: unknown };
    if (!Array.isArray(data.data)) throw new Error("no data array");
    posts = data.data as DailyDevPost[];
  } catch {
    throw new Error(`daily.dev answered ${response.status}, but not with a list of posts.`);
  }

  return posts
    .map((post) => toItem(post, options.link ?? "article"))
    .filter((item): item is SourceItem => item !== undefined)
    .slice(0, limit);
}

function toItem(post: DailyDevPost, link: DailyDevLink): SourceItem | undefined {
  // Posts shared in a squad have no title in the public API, and an email item needs one.
  const title = cleanText(post.title);
  if (!title) return undefined;

  const discussion = isHttpUrl(post.commentsPermalink ?? undefined) ? post.commentsPermalink! : undefined;
  const article = isHttpUrl(post.url ?? undefined) ? post.url! : undefined;
  const summary = cleanText(post.summary);

  return {
    title,
    url: link === "discussion" ? (discussion ?? article) : (article ?? discussion),
    summary: summary ? truncateText(summary, SUMMARY_MAX_LENGTH) : undefined,
    date: post.publishedAt ?? post.createdAt ?? undefined,
    author: cleanText(post.author?.name) || undefined,
    source: cleanText(post.source?.name) || undefined,
    image: isHttpUrl(post.image ?? undefined) ? post.image! : undefined,
  };
}
