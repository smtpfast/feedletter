import { XMLParser } from "fast-xml-parser";
import type { SourceItem } from "./types.js";
import { asArray, cleanText, decodeEntities, isHttpUrl, sortByDateDesc, truncateText } from "./utils.js";

interface LoadRssOptions {
  url: string;
  limit: number;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15000;
const SUMMARY_MAX_LENGTH = 300;
const USER_AGENT = "feedletter/0.2 (+https://github.com/smtpfast/feedletter)";

// Text fields are kept as raw XML (stopNodes) so text and CDATA can be read
// in order, each decoded by its own kind. Everything else (links, dates, guids)
// is decoded by the parser, once: htmlEntities covers &#8217; and named entities.
const TEXT_FIELDS = ["title", "description", "content:encoded", "summary", "content", "dc:creator", "name"];
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "text",
  cdataPropName: "__cdata",
  htmlEntities: true,
  parseTagValue: false,
  stopNodes: TEXT_FIELDS.map((tag) => `*.${tag}`),
});

interface Segment {
  text: string;
  /** From a CDATA section: entities in it were not decoded. */
  cdata: boolean;
}

interface TextNode {
  segments: Segment[];
  /** Atom's type attribute: text (the default), html, or xhtml. */
  type?: string;
}

/** Split a raw text field into text and CDATA segments, in order. Text is decoded once; comments are dropped. */
function segmentsOf(raw: string): Segment[] {
  const segments: Segment[] = [];
  const pattern = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->/g;
  let last = 0;
  for (let match = pattern.exec(raw); match; match = pattern.exec(raw)) {
    if (match.index > last) segments.push({ text: decodeEntities(raw.slice(last, match.index)), cdata: false });
    if (match[1] !== undefined) segments.push({ text: match[1], cdata: true });
    last = pattern.lastIndex;
  }
  if (last < raw.length) segments.push({ text: decodeEntities(raw.slice(last)), cdata: false });
  return segments;
}

/** A raw text field (see TEXT_FIELDS), as a string or { text, type }. */
function textNode(value: unknown): TextNode | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const node = textNode(entry);
      if (node) return node;
    }
    return undefined;
  }
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  const raw = typeof value === "string" ? value : typeof record?.text === "string" ? record.text : "";
  if (!raw.trim()) return undefined;
  return { segments: segmentsOf(raw), type: typeof record?.type === "string" ? record.type.toLowerCase() : undefined };
}

function firstNode(...values: unknown[]) {
  for (const value of values) {
    const node = textNode(value);
    if (node) return node;
  }
  return undefined;
}

/** The markup a field holds: decoded text and raw CDATA, joined in order. */
function htmlSource(node: TextNode | undefined) {
  return node ? node.segments.map((segment) => segment.text).join("") : "";
}

/** A field the parser decoded (link, guid, pubDate), as a string, { text }, or { __cdata }. */
function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    for (const entry of asArray(value)) {
      const record = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : undefined;
      const text = typeof entry === "string" ? entry : record ? `${typeof record.text === "string" ? record.text : ""}${asArray(record.__cdata).join("")}` : "";
      if (text.trim()) return text.trim();
    }
  }
  return undefined;
}

const collapse = (value: string) => value.replace(/\s+/g, " ").trim();

/** RSS plain text: text segments are already decoded; publishers write HTML entities inside CDATA. */
function rssPlain(node: TextNode | undefined) {
  if (!node) return "";
  return collapse(node.segments.map((segment) => (segment.cdata ? decodeEntities(segment.text) : segment.text)).join(""));
}

/** Atom text constructs: type="html" and "xhtml" are markup; "text" (the default) is literal, CDATA included. */
function atomText(node: TextNode | undefined) {
  if (!node) return "";
  return node.type === "html" || node.type === "xhtml" ? cleanText(htmlSource(node)) : collapse(htmlSource(node));
}

function atomLink(value: unknown): string | undefined {
  if (!value) return undefined;
  const entries = asArray(value);
  const plain = entries.find((link): link is string => typeof link === "string" && link.trim() !== "");
  const links = entries.filter(
    (link): link is Record<string, unknown> => typeof link === "object" && link !== null && typeof (link as Record<string, unknown>).href === "string",
  );
  // A link with no rel is an alternate link per the Atom spec.
  const alternates = links.filter((link) => link.rel === undefined || link.rel === "alternate");
  const chosen = alternates.find((link) => link.type === undefined || /html/i.test(String(link.type))) ?? alternates[0] ?? links[0];
  return (chosen?.href as string | undefined) ?? plain?.trim();
}

function resolveUrl(href: string, baseUrl: string): string | undefined {
  try {
    const url = new URL(href.trim(), baseUrl).toString();
    return isHttpUrl(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

/** The item's web link: <link>, then a URL-shaped <guid>. Relative links resolve against the feed. */
function rssLink(item: Record<string, unknown>, baseUrl: string): string | undefined {
  for (const candidate of asArray(item.link)) {
    const href = typeof candidate === "string" ? candidate.trim() : firstText(candidate) ?? atomLink(candidate);
    const url = href ? resolveUrl(href, baseUrl) : undefined;
    if (url) return url;
  }
  const guid = firstText(item.guid);
  return isHttpUrl(guid) ? resolveUrl(guid, baseUrl) : undefined;
}

/** RSS descriptions are HTML: strip tags, decode entities, and cut to card length. */
function rssSummary(...values: unknown[]) {
  return truncateText(cleanText(htmlSource(firstNode(...values))), SUMMARY_MAX_LENGTH);
}

function atomSummary(...values: unknown[]) {
  return truncateText(atomText(firstNode(...values)), SUMMARY_MAX_LENGTH);
}

function authorName(value: unknown, atom: boolean): string | undefined {
  const first = asArray(value)[0];
  const name = typeof first === "object" && first !== null && "name" in first ? (first as { name?: unknown }).name : first;
  const node = textNode(name);
  return (atom ? atomText(node) : rssPlain(node)) || undefined;
}

function records(value: unknown): Record<string, unknown>[] {
  return asArray(value).filter(
    (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
  );
}

function imageUrlFrom(value: unknown): string | undefined {
  for (const entry of asArray(value)) {
    if (entry && typeof entry === "object") {
      const url = (entry as Record<string, unknown>).url;
      if (typeof url === "string" && /^https?:\/\//i.test(url)) return url;
    }
  }
  return undefined;
}

function imageFromHtml(...values: unknown[]): string | undefined {
  for (const value of values) {
    const html = htmlSource(textNode(value));
    if (!html) continue;
    for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
      const match = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
      const src = match ? decodeEntities((match[1] ?? match[2] ?? match[3] ?? "").trim()) : "";
      if (/^https?:\/\//i.test(src)) return src;
    }
  }
  return undefined;
}

function firstImage(item: Record<string, unknown>): string | undefined {
  return (
    imageUrlFrom(item["media:content"]) ??
    imageUrlFrom(item["media:thumbnail"]) ??
    imageUrlFrom(item.enclosure) ??
    imageFromHtml(item["content:encoded"], item.description, item.content, item.summary)
  );
}

const charsetPattern = /charset\s*=\s*["']?([\w.:-]+)/i;

/** Decode the body with the charset from the BOM, the Content-Type header, or the XML declaration. */
export function decodeFeedBody(bytes: Uint8Array, contentType: string | null): string {
  let charset: string | undefined;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) charset = "utf-8";
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) charset = "utf-16le";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) charset = "utf-16be";
  charset ??= charsetPattern.exec(contentType ?? "")?.[1];
  if (!charset) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 512));
    charset = /<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(head)?.[1] ?? charsetPattern.exec(/<meta[^>]+charset[^>]*>/i.exec(head)?.[0] ?? "")?.[1];
  }
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function looksLikeHtml(body: string, contentType: string | null) {
  const head = body.slice(0, 2000);
  // Some servers label real feeds text/html, so the body decides first.
  if (/<(?:rss|feed|rdf:RDF)[\s>]/i.test(head)) return false;
  return /^\s*(?:<!--[\s\S]*?-->\s*)*<(?:!doctype\s+html|html)[\s>]/i.test(body) || /text\/html/i.test(contentType ?? "");
}

/** Find an RSS or Atom feed advertised by a web page with <link rel="alternate">. */
export function discoverFeedUrl(html: string, pageUrl: string): string | undefined {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attrs: Record<string, string> = {};
    for (const match of tag.matchAll(/([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
    }
    const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/);
    if (rel.includes("alternate") && /application\/(rss|atom)\+xml/i.test(attrs.type ?? "") && attrs.href) {
      try {
        return new URL(attrs.href, pageUrl).toString();
      } catch {
        /* skip a malformed href */
      }
    }
  }
  return undefined;
}

function withScheme(url: string) {
  const trimmed = url.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed.replace(/^\/+/, "")}`;
}

async function fetchFeed(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8",
          "user-agent": USER_AGENT,
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`The feed at ${url} did not answer within ${Math.round(timeoutMs / 1000)}s. Check the URL or try again.`);
      }
      throw new Error(`Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}. Check the URL and your connection.`);
    }

    if (!response.ok) {
      const hint =
        response.status === 404
          ? " Check the feed URL."
          : response.status === 401 || response.status === 403
            ? " The server refused the request; the feed may be private or block automated readers."
            : "";
      throw new Error(`The feed at ${url} returned ${response.status} ${response.statusText}.${hint}`.replace(/ \./, "."));
    }

    const contentType = response.headers?.get?.("content-type") ?? null;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`The feed at ${url} did not finish downloading within ${Math.round(timeoutMs / 1000)}s. Try again.`);
      }
      throw error;
    }
    return { body: decodeFeedBody(bytes, contentType), contentType, finalUrl: response.url || url };
  } finally {
    clearTimeout(timer);
  }
}

export async function loadRssFeed(options: LoadRssOptions): Promise<SourceItem[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let feedUrl = withScheme(options.url);
  let { body, contentType, finalUrl } = await fetchFeed(feedUrl, timeoutMs);

  // A blog's home page instead of its feed: follow the feed it advertises.
  if (looksLikeHtml(body, contentType)) {
    const discovered = discoverFeedUrl(body, finalUrl);
    if (!discovered) {
      throw new Error(
        `${feedUrl} is a web page, not a feed, and it does not link to one. Paste the feed URL instead (often /feed, /rss.xml, or /atom.xml).`,
      );
    }
    feedUrl = discovered;
    ({ body, contentType, finalUrl } = await fetchFeed(feedUrl, timeoutMs));
    if (looksLikeHtml(body, contentType)) {
      throw new Error(`${feedUrl} is a web page, not a feed. Paste the feed URL instead.`);
    }
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(body) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`The feed at ${feedUrl} is not valid XML: ${error instanceof Error ? error.message : String(error)}`);
  }
  const rss = parsed.rss as { channel?: { item?: unknown; link?: unknown } } | undefined;
  const rdf = parsed["rdf:RDF"] as { item?: unknown; channel?: unknown } | undefined;
  const atom = parsed.feed as { entry?: unknown } | undefined;
  const base = finalUrl;

  if (rss?.channel !== undefined || rdf) {
    const rawItems = rss?.channel ? rss.channel.item : rdf?.item;
    return sortByDateDesc(
      records(rawItems).map((item) => ({
        title: rssPlain(textNode(item.title)) || "Untitled",
        url: rssLink(item, base),
        summary: rssSummary(item.description, item["content:encoded"]),
        content: htmlSource(firstNode(item["content:encoded"], item.description)) || undefined,
        date: firstText(item.pubDate, item["dc:date"], item.isoDate),
        author: authorName(item["dc:creator"], false) ?? firstText(item.author),
        source: feedUrl,
        image: firstImage(item),
      })),
    ).slice(0, options.limit);
  }

  if (atom !== undefined) {
    return sortByDateDesc(
      records(atom.entry).map((entry) => {
        const link = atomLink(entry.link);
        return {
          title: atomText(textNode(entry.title)) || "Untitled",
          url: link ? resolveUrl(link, base) : undefined,
          summary: atomSummary(entry.summary, entry.content),
          content: htmlSource(firstNode(entry.content, entry.summary)) || undefined,
          // published is when the post went out; updated moves on every small edit.
          date: firstText(entry.published, entry.updated),
          author: authorName(entry.author, true),
          source: feedUrl,
          image: firstImage(entry),
        };
      }),
    ).slice(0, options.limit);
  }

  throw new Error(`${feedUrl} did not return an RSS or Atom feed. Check that the URL points at the feed itself.`);
}
