import { readFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import matter from "gray-matter";
import type { SourceItem } from "./types.js";
import { excerpt, normalizeUrl, sortByDateDesc } from "./utils.js";

interface LoadContentOptions {
  dir: string;
  baseUrl?: string;
  limit: number;
}

function slugFromFile(filePath: string) {
  return path.basename(filePath).replace(/\.(md|mdx)$/i, "");
}

function frontmatterString(data: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value instanceof Date) return value.toISOString();
  }
  return undefined;
}

export async function loadContentDirectory(options: LoadContentOptions): Promise<SourceItem[]> {
  const files = await fg(["**/*.md", "**/*.mdx"], {
    cwd: options.dir,
    absolute: true,
    onlyFiles: true,
    ignore: ["**/node_modules/**", "**/.next/**", "**/dist/**"],
  });

  const items = await Promise.all(
    files.map(async (file) => {
      const raw = await readFile(file, "utf8");
      const parsed = matter(raw);
      const data = parsed.data as Record<string, unknown>;
      const slug = frontmatterString(data, ["slug"]) ?? slugFromFile(file);
      const url =
        frontmatterString(data, ["url", "canonical", "canonicalUrl"]) ??
        (options.baseUrl ? `/blog/${slug}` : undefined);

      return {
        title:
          frontmatterString(data, ["title"]) ??
          slug.replace(/[-_]/g, " ").replace(/\b\w/g, (char) => char.toUpperCase()),
        url: normalizeUrl(url, options.baseUrl),
        summary:
          frontmatterString(data, ["description", "summary", "excerpt"]) ??
          excerpt(parsed.content),
        content: parsed.content,
        date: frontmatterString(data, ["date", "publishedAt", "createdAt", "updatedAt"]),
        author: frontmatterString(data, ["author"]),
        source: "content",
      } satisfies SourceItem;
    }),
  );

  return sortByDateDesc(items).slice(0, options.limit);
}
