import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function cleanText(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function stripMarkdown(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_>#-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function excerpt(value: string, maxLength = 220): string {
  const cleaned = cleanText(stripMarkdown(value));
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength).replace(/\s+\S*$/, "")}...`;
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

export function sortByDateDesc<T extends { date?: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const aTime = a.date ? Date.parse(a.date) : 0;
    const bTime = b.date ? Date.parse(b.date) : 0;
    return bTime - aTime;
  });
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
