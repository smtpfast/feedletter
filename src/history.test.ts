import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
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

describe("HistoryStore send lock", () => {
  it("refuses a second send while another holds the lock", async () => {
    const dbPath = path.join(dir, "history.sqlite");
    const a = await HistoryStore.open(dbPath);
    const b = await HistoryStore.open(dbPath);
    let release!: () => void;
    const holding = a.exclusive(() => new Promise<void>((resolve) => (release = resolve)));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(b.exclusive(async () => "sent")).rejects.toThrow(/Another feedletter send is using .*process \d+/);
    release();
    await holding;
    await expect(b.exclusive(async () => "sent")).resolves.toBe("sent");
    a.close();
    b.close();
  });

  it("takes over a lock whose process is gone, and removes it afterwards", async () => {
    const dbPath = path.join(dir, "history.sqlite");
    const store = await HistoryStore.open(dbPath);
    await writeFile(`${dbPath}.lock`, "2147483646\n");
    await expect(store.exclusive(async () => "ok")).resolves.toBe("ok");
    await expect(access(`${dbPath}.lock`)).rejects.toThrow();
    store.close();
  });

  it("keeps both processes' progress instead of overwriting it", async () => {
    const dbPath = path.join(dir, "history.sqlite");
    // Both open before either writes, like a running studio and a CLI send.
    const a = await HistoryStore.open(dbPath);
    const b = await HistoryStore.open(dbPath);
    await a.exclusive(() => a.recordRecipients("key", [{ recipient: "one@example.com" }]));
    await b.exclusive(() => b.recordRecipients("key", [{ recipient: "two@example.com" }], "uncertain"));
    a.close();
    b.close();

    const reopened = await HistoryStore.open(dbPath);
    expect([...reopened.sentRecipients("key")].sort()).toEqual([
      ["one@example.com", "sent"],
      ["two@example.com", "uncertain"],
    ]);
    reopened.close();
  });
});

