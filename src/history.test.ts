import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

    await store.exclusive(() => store.recordIssue(issueOf(items)));
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

  it("does not write the file when it is opened", async () => {
    const dbPath = path.join(dir, "history.sqlite");
    const store = await HistoryStore.open(dbPath);
    expect(existsSync(dbPath)).toBe(false);
    await store.exclusive(() => store.recordIssue(issueOf(items)));
    expect(existsSync(dbPath)).toBe(true);
    store.close();
  });

  it("refuses to write outside the lock", async () => {
    const store = await HistoryStore.open(path.join(dir, "history.sqlite"));
    await expect(store.recordIssue(issueOf(items))).rejects.toThrow(/outside its lock/);
    store.close();
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
    let holding!: Promise<void>;
    // Wait until a really holds the lock before b tries.
    await new Promise<void>((held) => {
      holding = a.exclusive(() => new Promise<void>((resolve) => {
        release = resolve;
        held();
      }));
    });
    await expect(b.exclusive(async () => "sent")).rejects.toThrow(/Another feedletter send is using .*process \d+/);
    release();
    await holding;
    await expect(b.exclusive(async () => "sent")).resolves.toBe("sent");
    a.close();
    b.close();
  });

  it("stops, and leaves the lock in place, when the process that held it is gone", async () => {
    const dbPath = path.join(dir, "history.sqlite");
    const store = await HistoryStore.open(dbPath);
    await writeFile(`${dbPath}.lock`, "2147483646\n");
    let ran = false;
    await expect(store.exclusive(async () => (ran = true))).rejects.toThrow(
      /A previous send did not finish: .*history\.sqlite\.lock is still there \(process 2147483646\)\. If no other Feedletter is running/,
    );
    expect(ran).toBe(false);
    expect(existsSync(`${dbPath}.lock`)).toBe(true);
    store.close();
  });

  it("keeps earlier sends when a --resend batch is refused", async () => {
    const dbPath = path.join(dir, "history.sqlite");
    const store = await HistoryStore.open(dbPath);
    await store.exclusive(async () => {
      await store.recordRecipients("key", [{ recipient: "sent@example.com", id: "e1" }]);
      await store.recordRecipients("key", [{ recipient: "maybe@example.com" }], "uncertain");
      // A --resend writes the batch ahead, then SMTPfast answers 4xx.
      const batch = ["sent@example.com", "maybe@example.com", "new@example.com"];
      await store.recordRecipients("key", batch.map((recipient) => ({ recipient })), "uncertain");
      await store.forgetRecipients("key", batch);
    });
    expect([...store.sentRecipients("key")].sort()).toEqual([
      ["maybe@example.com", "uncertain"],
      ["sent@example.com", "sent"],
    ]);
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

describe("HistoryStore batch keys", () => {
  it("adds the batch key column to a history file written before it existed, and keeps old rows unreplayable", async () => {
    const dbPath = path.join(dir, "old.sqlite");
    const initSqlJs = (await import("sql.js")).default;
    const SQL = await initSqlJs();
    const old = new SQL.Database();
    old.run(`CREATE TABLE sent_recipients (send_key TEXT NOT NULL, recipient TEXT NOT NULL, email_id TEXT, sent_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'sent', PRIMARY KEY (send_key, recipient));
      INSERT INTO sent_recipients VALUES ('key', 'old@example.com', NULL, '2026-10-01T00:00:00Z', 'uncertain');`);
    await writeFile(dbPath, Buffer.from(old.export()));
    old.close();

    const store = await HistoryStore.open(dbPath);
    expect(store.sentRecipients("key").get("old@example.com")).toBe("uncertain");
    expect(store.uncertainBatches("key")).toEqual([]);
    await store.exclusive(() => store.recordRecipients("key", [{ recipient: "New@example.com" }, { recipient: "two@example.com" }], "uncertain", "feedletter-abc"));
    expect(store.uncertainBatches("key")).toEqual([{ key: "feedletter-abc", recipients: ["new@example.com", "two@example.com"] }]);
    await store.exclusive(() => store.releaseUncertain("key", ["NEW@example.com"]));
    expect(store.sentRecipients("key").has("new@example.com")).toBe(false);
    store.close();
  });
});

