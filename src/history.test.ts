import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    expect([...store.sentRecipients("key", ["sent@example.com", "maybe@example.com", "new@example.com"])].sort()).toEqual([
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
    expect([...reopened.sentRecipients("key", ["one@example.com", "two@example.com"])].sort()).toEqual([
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
    const list = ["old@example.com", "New@example.com", "two@example.com"];
    expect(store.sentRecipients("key", list).get("old@example.com")).toBe("uncertain");
    expect(store.uncertainBatches("key", list)).toEqual([]);
    await store.exclusive(() => store.recordRecipients("key", [{ recipient: "New@example.com" }, { recipient: "two@example.com" }], "uncertain", "feedletter-abc"));
    expect(store.uncertainBatches("key", list)).toEqual([{ key: "feedletter-abc", recipients: ["new@example.com", "two@example.com"], startedAt: expect.any(String) }]);
    store.close();
  });
});


describe("HistoryStore recipient hashes", () => {
  const KEY = "dummy-history-key-0123456789abcdef";
  const list = ["Reader0@example.test", "reader1@example.test", "reader2@example.test"];

  async function rawRecipients(dbPath: string) {
    const initSqlJs = (await import("sql.js")).default;
    const SQL = await initSqlJs();
    const db = new SQL.Database(await readFile(dbPath));
    const rows = db.exec("SELECT recipient FROM sent_recipients ORDER BY rowid")[0]?.values.map((row) => String(row[0])) ?? [];
    db.close();
    return rows;
  }

  it("stores keyed hashes, never addresses, and still matches this run's list", async () => {
    const dbPath = path.join(dir, "history.sqlite");
    const store = await HistoryStore.open(dbPath, { recipientKey: KEY });
    await store.exclusive(async () => {
      await store.recordRecipients("key", [{ recipient: list[0], id: "e0" }]);
      await store.recordRecipients("key", [{ recipient: list[1] }], "uncertain", "scope:k1");
    });
    store.close();

    const raw = await rawRecipients(dbPath);
    expect(raw).toHaveLength(2);
    expect(raw.filter((value) => value.includes("@"))).toEqual([]);
    expect(raw.every((value) => /^hmac:[0-9a-f]{64}$/.test(value))).toBe(true);

    const reopened = await HistoryStore.open(dbPath, { recipientKey: KEY });
    expect([...reopened.sentRecipients("key", list)].sort()).toEqual([
      ["reader0@example.test", "sent"],
      ["reader1@example.test", "uncertain"],
    ]);
    expect(reopened.uncertainBatches("key", list)).toEqual([{ key: "scope:k1", recipients: ["reader1@example.test"], startedAt: expect.any(String) }]);
    // An address that left the list cannot be matched, so its batch is never replayed for someone else.
    expect(reopened.uncertainBatches("key", [list[0]])[0].recipients[0]).toMatch(/^hmac:/);
    reopened.close();
  });

  it("turns plain addresses from an older file into hashes on the next locked write", async () => {
    const dbPath = path.join(dir, "history.sqlite");
    const plain = await HistoryStore.open(dbPath);
    await plain.exclusive(async () => {
      await plain.recordRecipients("key", [{ recipient: list[0], id: "e0" }]);
      await plain.recordRecipients("key", [{ recipient: list[1] }, { recipient: list[2] }], "uncertain", "scope:k1");
    });
    plain.close();
    expect((await rawRecipients(dbPath)).filter((value) => value.includes("@"))).toHaveLength(3);

    const store = await HistoryStore.open(dbPath, { recipientKey: KEY });
    // Reading works before anything is written.
    expect(store.sentRecipients("key", list).get("reader0@example.test")).toBe("sent");
    await store.exclusive(async () => undefined);
    store.close();

    expect((await rawRecipients(dbPath)).filter((value) => value.includes("@"))).toEqual([]);
    const reopened = await HistoryStore.open(dbPath, { recipientKey: KEY });
    expect([...reopened.sentRecipients("key", list)].sort()).toEqual([
      ["reader0@example.test", "sent"],
      ["reader1@example.test", "uncertain"],
      ["reader2@example.test", "uncertain"],
    ]);
    // The batch keeps its order and its key.
    expect(reopened.uncertainBatches("key", list)).toEqual([
      { key: "scope:k1", recipients: ["reader1@example.test", "reader2@example.test"], startedAt: expect.any(String) },
    ]);
    reopened.close();
  });

  it("refuses to read or write recipients without the key, or with another one", async () => {
    const dbPath = path.join(dir, "history.sqlite");
    const store = await HistoryStore.open(dbPath, { recipientKey: KEY });
    await store.exclusive(() => store.recordRecipients("key", [{ recipient: list[0] }]));
    store.close();

    const noKey = await HistoryStore.open(dbPath);
    expect(() => noKey.sentRecipients("key", list)).toThrow(/stores recipients as keyed hashes\. Set FEEDLETTER_HISTORY_KEY/);
    expect(() => noKey.uncertainBatches("key", list)).toThrow(/keyed hashes/);
    await expect(noKey.exclusive(() => noKey.recordRecipients("key", [{ recipient: list[1] }]))).rejects.toThrow(/keyed hashes/);
    // Item history needs no key.
    await noKey.exclusive(() => noKey.recordIssue(issueOf(items)));
    noKey.close();

    const otherKey = await HistoryStore.open(dbPath, { recipientKey: "another-dummy-key-0123456789" });
    expect(() => otherKey.sentRecipients("key", list)).toThrow(/not the key this history file was written with/);
    otherKey.close();
  });

  it("rejects a short key", async () => {
    await expect(HistoryStore.open(path.join(dir, "history.sqlite"), { recipientKey: "short" })).rejects.toThrow(/at least 16 characters/);
  });
});
