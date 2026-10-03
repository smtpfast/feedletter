import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", AMP: "&", LT: "<", GT: ">", QUOT: '"',
  hellip: "\u2026", mdash: "\u2014", ndash: "\u2013", minus: "\u2212",
  lsquo: "\u2018", rsquo: "\u2019", sbquo: "\u201a", ldquo: "\u201c", rdquo: "\u201d", bdquo: "\u201e",
  laquo: "\u00ab", raquo: "\u00bb", lsaquo: "\u2039", rsaquo: "\u203a",
  bull: "\u2022", middot: "\u00b7", copy: "\u00a9", reg: "\u00ae", trade: "\u2122",
  deg: "\u00b0", times: "\u00d7", divide: "\u00f7", plusmn: "\u00b1", frac12: "\u00bd",
  euro: "\u20ac", pound: "\u00a3", yen: "\u00a5", cent: "\u00a2", sect: "\u00a7", para: "\u00b6",
  iexcl: "\u00a1", iquest: "\u00bf", shy: "", zwnj: "", zwj: "", ensp: " ", emsp: " ", thinsp: " ",
  aacute: "\u00e1", eacute: "\u00e9", iacute: "\u00ed", oacute: "\u00f3", uacute: "\u00fa",
  Aacute: "\u00c1", Eacute: "\u00c9", Iacute: "\u00cd", Oacute: "\u00d3", Uacute: "\u00da",
  agrave: "\u00e0", egrave: "\u00e8", igrave: "\u00ec", ograve: "\u00f2", ugrave: "\u00f9",
  Agrave: "\u00c0", Egrave: "\u00c8", Igrave: "\u00cc", Ograve: "\u00d2", Ugrave: "\u00d9",
  acirc: "\u00e2", ecirc: "\u00ea", icirc: "\u00ee", ocirc: "\u00f4", ucirc: "\u00fb",
  auml: "\u00e4", euml: "\u00eb", iuml: "\u00ef", ouml: "\u00f6", uuml: "\u00fc", yuml: "\u00ff",
  Auml: "\u00c4", Ouml: "\u00d6", Uuml: "\u00dc", szlig: "\u00df",
  atilde: "\u00e3", otilde: "\u00f5", ntilde: "\u00f1", Ntilde: "\u00d1", ccedil: "\u00e7", Ccedil: "\u00c7",
  aring: "\u00e5", Aring: "\u00c5", aelig: "\u00e6", AElig: "\u00c6", oslash: "\u00f8", Oslash: "\u00d8",
};

/** Decode numeric and common named HTML entities. Unknown names are left as-is. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (match, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return match;
      return String.fromCodePoint(code);
    }
    // Entity names are case-sensitive: &Egrave; and &egrave; are different letters.
    return Object.hasOwn(NAMED_ENTITIES, ref) ? NAMED_ENTITIES[ref] : match;
  });
}

/**
 * Turn an HTML or plain-text fragment into one line of readable text: drop
 * script/style blocks, comments, and tags, decode entities, and collapse
 * whitespace. Only tag-shaped "<" sequences are removed, so "a < b" survives.
 */
export function cleanText(value: unknown): string {
  if (value === undefined || value === null) return "";
  const withoutTags = String(value)
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/?[a-z][a-z0-9:-]*(?:\s[^>]*)?\/?>/gi, " ");
  return decodeEntities(withoutTags).replace(/\s+/g, " ").trim();
}

export function stripMarkdown(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*(import|export)\s.+$/gm, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, " ")
    .replace(/(\*{1,3})(\S(?:[^\n]*?\S)?)\1/g, "$2")
    .replace(/(^|[^\w])(_{1,3})(\S(?:[^\n]*?\S)?)\2(?![\w])/g, "$1$3")
    .replace(/\s+/g, " ")
    .trim();
}

/** Shorten text to at most maxLength characters, cutting at a word boundary. */
export function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const cut = value.slice(0, maxLength).replace(/\s+\S*$/, "").replace(/[\s,;:.\u2026-]+$/, "");
  return `${cut || value.slice(0, maxLength)}...`;
}

export function excerpt(value: string, maxLength = 220): string {
  return truncateText(cleanText(stripMarkdown(value)), maxLength);
}

/** The host of a URL for labels ("blog.example.com"), tolerating a missing scheme. */
export function hostLabel(url: string | undefined, fallback: string): string {
  if (!url) return fallback;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
    return new URL(withScheme).hostname.replace(/^www\./, "") || fallback;
  } catch {
    return fallback;
  }
}

export function isHttpUrl(value: string | undefined): value is string {
  return typeof value === "string" && /^https?:\/\/[^\s]+$/i.test(value.trim());
}

export function normalizeUrl(url: string | undefined, baseUrl?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).toString();
  } catch {
    if (!baseUrl) return url;
    return new URL(url.replace(/^\//, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
  }
}

function timeOf(value?: string) {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

export function sortByDateDesc<T extends { date?: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => timeOf(b.date) - timeOf(a.date));
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function writeOutputFile(outDir: string, fileName: string, content: string) {
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, fileName), content, "utf8");
}

export function requireOneSource(rss?: string, contentDir?: string) {
  if (!rss && !contentDir) {
    throw new Error("Provide one source: --rss <url> or --content <dir>.");
  }
  if (rss && contentDir) {
    throw new Error("Use either --rss or --content, not both.");
  }
}
