import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HistoryStore, itemHistoryKey } from "./history.js";
import type { DigestIssue, SourceItem } from "./types.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "feedletter-history-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const items: SourceItem[] = [
  { title: "One", url: "https://example.com/1" },
  { title: "Two", url: "https://example.com/2" },
];

function issueOf(list: SourceItem[]): DigestIssue {
  return {
    title: "Digest",
    preheader: "p",
    intro: "i",
    sourceLabel: "src",
    generatedAt: "2026-05-31T00:00:00.000Z",
    items: list,
  };
}

describe("HistoryStore", () => {
  it("marks recorded items as seen and persists across reopen", async () => {
    const dbPath = path.join(dir, "history.sqlite");
    const store = await HistoryStore.open(dbPath);
    expect(store.seenKeys(items).size).toBe(0);

    await store.recordIssue(issueOf(items));
    expect(store.seenKeys(items).size).toBe(2);
    store.close();

    const reopened = await HistoryStore.open(dbPath);
    const seen = reopened.seenKeys(items);
    expect(seen.has(itemHistoryKey(items[0]))).toBe(true);
    expect(seen.has(itemHistoryKey(items[1]))).toBe(true);

    const fresh: SourceItem = { title: "Three", url: "https://example.com/3" };
    expect(reopened.seenKeys([fresh]).size).toBe(0);
    reopened.close();
  });

  it("keys items by url so titles can change", () => {
    const a = itemHistoryKey({ title: "Original", url: "https://example.com/x" });
    const b = itemHistoryKey({ title: "Renamed", url: "https://example.com/x" });
    expect(a).toBe(b);
  });
});
