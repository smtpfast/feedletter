import { XMLParser } from "fast-xml-parser";
import type { SourceItem } from "./types.js";
import { asArray, cleanText, normalizeUrl, sortByDateDesc } from "./utils.js";

interface LoadRssOptions {
  url: string;
  limit: number;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15000;
const USER_AGENT = "feedletter/0.2 (+https://github.com/smtpfast/feedletter)";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "text",
});

function firstText(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "object" && value !== null && "text" in value) {
      const text = String((value as { text?: unknown }).text ?? "").trim();
      if (text) return text;
    }
  }
  return undefined;
}

function atomLink(value: unknown): string | undefined {
  if (!value) return undefined;
  const links = asArray(value).filter(
    (link): link is Record<string, unknown> => typeof link === "object" && link !== null,
  );
  const alternate = links.find((link) => link.rel === "alternate") ?? links[0];
  if (typeof alternate === "string") return alternate;
  if (alternate && typeof alternate.href === "string") return alternate.href;
  return undefined;
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
    if (typeof value === "string") {
      const match = value.match(/<img[^>]+src=["']([^"']+)["']/i);
      if (match && /^https?:\/\//i.test(match[1])) return match[1];
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

export async function loadRssFeed(options: LoadRssOptions): Promise<SourceItem[]> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(options.url, {
      headers: {
        accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
        "user-agent": USER_AGENT,
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`RSS fetch timed out after ${timeoutMs}ms: ${options.url}`);
    }
    throw new Error(`RSS fetch failed for ${options.url}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`RSS fetch failed with ${response.status} ${response.statusText}`);
  }

  const xml = await response.text();
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const rss = parsed.rss as { channel?: { item?: unknown } } | undefined;
  const atom = parsed.feed as { entry?: unknown } | undefined;

  if (rss?.channel?.item) {
    return sortByDateDesc(
      records(rss.channel.item).map((item) => ({
        title: firstText(item.title) ?? "Untitled",
        url: normalizeUrl(firstText(item.link, item.guid)),
        summary: cleanText(firstText(item.description, item["content:encoded"])),
        content: firstText(item["content:encoded"], item.description),
        date: firstText(item.pubDate, item.isoDate),
        author: firstText(item.author, item["dc:creator"]),
        source: options.url,
        image: firstImage(item),
      })),
    ).slice(0, options.limit);
  }

  if (atom?.entry) {
    return sortByDateDesc(
      records(atom.entry).map((entry) => ({
        title: firstText(entry.title) ?? "Untitled",
        url: normalizeUrl(atomLink(entry.link)),
        summary: cleanText(firstText(entry.summary, entry.content)),
        content: firstText(entry.content, entry.summary),
        date: firstText(entry.updated, entry.published),
        author: firstText((entry.author as { name?: unknown } | undefined)?.name),
        source: options.url,
        image: firstImage(entry),
      })),
    ).slice(0, options.limit);
  }

  throw new Error("Unsupported feed format. Expected RSS channel items or Atom entries.");
}
