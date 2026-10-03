import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import initSqlJs, { type Database } from "sql.js";
import type { DigestIssue, SourceItem } from "./types.js";

const require = createRequire(import.meta.url);

export function itemHistoryKey(item: SourceItem) {
  const stableValue = item.url || `${item.source || ""}|${item.title}|${item.date || ""}`;
  return createHash("sha256").update(stableValue).digest("hex");
}

function issueHistoryKey(issue: DigestIssue) {
  return createHash("sha256")
    .update(`${issue.title}|${issue.generatedAt}|${issue.items.map(itemHistoryKey).join(",")}`)
    .digest("hex");
}

export class HistoryStore {
  private constructor(
    private readonly dbPath: string,
    private readonly db: Database,
  ) {}

  static async open(dbPath: string) {
    await mkdir(path.dirname(dbPath), { recursive: true });
    const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
    const SQL = await initSqlJs({ locateFile: () => wasmPath });

    let db: Database;
    try {
      const existing = await readFile(dbPath);
      db = new SQL.Database(existing);
    } catch {
      db = new SQL.Database();
    }

    const store = new HistoryStore(dbPath, db);
    store.migrate();
    await store.persist();
    return store;
  }

  seenKeys(items: SourceItem[]) {
    const seen = new Set<string>();
    const stmt = this.db.prepare("SELECT item_key FROM included_items WHERE item_key = ?");
    try {
      for (const item of items) {
        const key = itemHistoryKey(item);
        stmt.bind([key]);
        if (stmt.step()) seen.add(key);
        stmt.reset();
      }
    } finally {
      stmt.free();
    }
    return seen;
  }

  async recordIssue(issue: DigestIssue) {
    const issueKey = issueHistoryKey(issue);
    this.db.run(
      "INSERT OR IGNORE INTO issues (issue_key, title, source_label, generated_at, item_count) VALUES (?, ?, ?, ?, ?)",
      [issueKey, issue.title, issue.sourceLabel, issue.generatedAt, issue.items.length],
    );

    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO included_items (item_key, issue_key, title, url, source, published_at, included_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    try {
      for (const item of issue.items) {
        stmt.run([
          itemHistoryKey(item),
          issueKey,
          item.title,
          item.url ?? null,
          item.source ?? null,
          item.date ?? null,
          issue.generatedAt,
        ]);
      }
    } finally {
      stmt.free();
    }

    await this.persist();
  }

  /** Lowercased addresses SMTPfast already accepted for this exact send (see sendKey). */
  sentRecipients(sendKey: string) {
    const sent = new Set<string>();
    const stmt = this.db.prepare("SELECT recipient FROM sent_recipients WHERE send_key = ?");
    try {
      stmt.bind([sendKey]);
      while (stmt.step()) sent.add(String(stmt.get()[0]));
    } finally {
      stmt.free();
    }
    return sent;
  }

  /** Save addresses from an accepted batch, so a rerun of the same send skips them. */
  async recordRecipients(sendKey: string, rows: Array<{ recipient: string; id?: string }>) {
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO sent_recipients (send_key, recipient, email_id, sent_at) VALUES (?, ?, ?, ?)",
    );
    const now = new Date().toISOString();
    try {
      for (const row of rows) stmt.run([sendKey, row.recipient.toLowerCase(), row.id ?? null, now]);
    } finally {
      stmt.free();
    }
    await this.persist();
  }

  /** The broadcast created for this exact send, if any. */
  broadcastFor(sendKey: string): string | undefined {
    const stmt = this.db.prepare("SELECT broadcast_id FROM broadcasts WHERE send_key = ?");
    try {
      stmt.bind([sendKey]);
      return stmt.step() ? String(stmt.get()[0]) : undefined;
    } finally {
      stmt.free();
    }
  }

  async recordBroadcast(sendKey: string, broadcastId: string) {
    this.db.run("INSERT OR REPLACE INTO broadcasts (send_key, broadcast_id, created_at) VALUES (?, ?, ?)", [
      sendKey,
      broadcastId,
      new Date().toISOString(),
    ]);
    await this.persist();
  }

  close() {
    this.db.close();
  }

  private migrate() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS issues (
        issue_key TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        source_label TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        item_count INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS included_items (
        item_key TEXT PRIMARY KEY,
        issue_key TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT,
        source TEXT,
        published_at TEXT,
        included_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sent_recipients (
        send_key TEXT NOT NULL,
        recipient TEXT NOT NULL,
        email_id TEXT,
        sent_at TEXT NOT NULL,
        PRIMARY KEY (send_key, recipient)
      );

      CREATE TABLE IF NOT EXISTS broadcasts (
        send_key TEXT PRIMARY KEY,
        broadcast_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS included_items_issue_key_idx ON included_items(issue_key);
      CREATE INDEX IF NOT EXISTS included_items_included_at_idx ON included_items(included_at);
    `);
  }

  private async persist() {
    const data = this.db.export();
    await writeFile(this.dbPath, Buffer.from(data));
  }
}
