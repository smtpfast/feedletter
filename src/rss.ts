import { XMLParser } from "fast-xml-parser";
import type { SourceItem } from "./types.js";
import { asArray, cleanText, normalizeUrl, sortByDateDesc } from "./utils.js";

interface LoadRssOptions {
  url: string;
  limit: number;
}

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

export async function loadRssFeed(options: LoadRssOptions): Promise<SourceItem[]> {
  const response = await fetch(options.url, {
    headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
  });

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
      })),
    ).slice(0, options.limit);
  }

  throw new Error("Unsupported feed format. Expected RSS channel items or Atom entries.");
}
