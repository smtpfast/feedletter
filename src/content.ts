import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import matter from "gray-matter";
import type { SourceItem } from "./types.js";
import { excerpt, mapWithConcurrency, normalizeUrl, sortByDateDesc } from "./utils.js";

interface LoadContentOptions {
  dir: string;
  baseUrl?: string;
  limit: number;
}

const READ_CONCURRENCY = 16;

function slugFromFile(filePath: string) {
  return path.basename(filePath).replace(/\.(md|mdx)$/i, "");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function frontmatterString(data: Record<string, unknown>, keys: string[], rawFrontmatter = "") {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      // YAML turns both `2026-05-30` and `2026-05-30T00:00:00Z` into a Date.
      // Only a bare calendar date stays a plain date (so it does not show as
      // the day before west of UTC); a timestamp keeps its time.
      const bareDate = new RegExp(`^${escapeRegExp(key)}\\s*:\\s*(\\d{4}-\\d{2}-\\d{2})\\s*(?:#.*)?$`, "m").exec(rawFrontmatter);
      return bareDate ? bareDate[1] : value.toISOString();
    }
  }
  return undefined;
}

async function assertDirectory(dir: string) {
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) throw new Error(`${dir} is a file, not a directory. Point --content at the folder that holds your Markdown posts.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Content directory not found: ${dir}. Check the path; it is resolved from where you ran feedletter.`);
    }
    throw error;
  }
}

export async function loadContentDirectory(options: LoadContentOptions): Promise<SourceItem[]> {
  await assertDirectory(options.dir);
  const files = await fg(["**/*.md", "**/*.mdx"], {
    cwd: options.dir,
    absolute: true,
    onlyFiles: true,
    ignore: ["**/node_modules/**", "**/.next/**", "**/dist/**"],
  });

  const items = await mapWithConcurrency(files, READ_CONCURRENCY, async (file) => {
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
      date: frontmatterString(data, ["date", "publishedAt", "createdAt", "updatedAt"], parsed.matter),
      author: frontmatterString(data, ["author"]),
      source: "content",
      image: normalizeUrl(
        frontmatterString(data, ["image", "cover", "coverImage", "ogImage", "thumbnail"]) ??
          parsed.content.match(/!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/)?.[1],
        options.baseUrl,
      ),
    } satisfies SourceItem;
  });

  return sortByDateDesc(items).slice(0, options.limit);
}
