import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
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

/** Whether a recipient was accepted by SMTPfast, or a batch failed in a way that may have sent it. */
export type RecipientState = "sent" | "uncertain";

function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The history file is locked by another send, or by one that did not finish. */
export class HistoryLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryLockError";
  }
}

export class HistoryStore {
  private locked = false;
  /** Rows the current batch's write-ahead created (they did not exist before), per send key. */
  private writtenAhead = new Map<string, Set<string>>();

  private constructor(
    private readonly dbPath: string,
    private readonly SQL: SqlJsStatic,
    private db: Database,
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

    // Opening never writes: the tables are created in memory, and the file is
    // only written under the lock (see exclusive), so an old snapshot can never
    // be renamed over another process's newer progress.
    const store = new HistoryStore(dbPath, SQL, db);
    store.migrate();
    return store;
  }

  /**
   * Run fn while holding an exclusive lock file next to the history file, after
   * re-reading the file, so two processes cannot send at once or overwrite
   * each other's progress. Every write happens in here. The lock holds the pid.
   * A lock is never taken over: if its process is gone, a previous send did not
   * finish, and a person has to look before anything is sent again.
   */
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const lockPath = `${this.dbPath}.lock`;
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number.parseInt((await readFile(lockPath, "utf8").catch(() => "")).trim(), 10);
      const holder = Number.isInteger(pid) && pid > 0 ? ` (process ${pid})` : "";
      if (holder && processAlive(pid)) {
        throw new HistoryLockError(`Another feedletter send is using ${this.dbPath}${holder}. Wait for it to finish.`);
      }
      throw new HistoryLockError(
        `A previous send did not finish: ${lockPath} is still there${holder}. If no other Feedletter is running, check the SMTPfast logs, then remove ${lockPath}.`,
      );
    }
    this.locked = true;
    try {
      await this.reload();
      return await fn();
    } finally {
      this.locked = false;
      await rm(lockPath, { force: true });
    }
  }

  /** Re-read the history file, to see what another process wrote. */
  async reload() {
    let data: Buffer;
    try {
      data = await readFile(this.dbPath);
    } catch {
      return;
    }
    const next = new this.SQL.Database(data);
    this.db.close();
    this.db = next;
    this.migrate();
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

  /** Lowercased addresses an earlier run of this exact send (see sendKey) sent, or may have sent. */
  sentRecipients(sendKey: string) {
    const sent = new Map<string, RecipientState>();
    const stmt = this.db.prepare("SELECT recipient, state FROM sent_recipients WHERE send_key = ?");
    try {
      stmt.bind([sendKey]);
      while (stmt.step()) {
        const [recipient, state] = stmt.get();
        sent.set(String(recipient), state === "uncertain" ? "uncertain" : "sent");
      }
    } finally {
      stmt.free();
    }
    return sent;
  }

  /**
   * Save the addresses of one batch, so a rerun of the same send skips them.
   * Writing ahead as uncertain never touches an existing row, so a refused
   * --resend cannot erase what an earlier run sent.
   */
  async recordRecipients(
    sendKey: string,
    rows: Array<{ recipient: string; id?: string }>,
    state: RecipientState = "sent",
    batchKey?: string,
  ) {
    const ahead = state === "uncertain";
    const stmt = this.db.prepare(
      `INSERT OR ${ahead ? "IGNORE" : "REPLACE"} INTO sent_recipients (send_key, recipient, email_id, sent_at, state, batch_key) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const now = new Date().toISOString();
    // Batches go one at a time, so the set only ever holds the current batch.
    const written = ahead ? new Set<string>() : (this.writtenAhead.get(sendKey) ?? new Set<string>());
    try {
      for (const row of rows) {
        const recipient = row.recipient.toLowerCase();
        stmt.run([sendKey, recipient, row.id ?? null, now, state, batchKey ?? null]);
        if (ahead && this.db.getRowsModified() > 0) written.add(recipient);
        if (!ahead) written.delete(recipient);
      }
    } finally {
      stmt.free();
    }
    this.writtenAhead.set(sendKey, written);
    await this.persist();
  }

  /**
   * Remove addresses written ahead of a batch that SMTPfast then refused (a
   * 4xx: nothing was queued). Only rows the write-ahead created are removed;
   * rows from earlier runs stay as they were.
   */
  async forgetRecipients(sendKey: string, recipients: string[]) {
    const written = this.writtenAhead.get(sendKey);
    const stmt = this.db.prepare("DELETE FROM sent_recipients WHERE send_key = ? AND recipient = ?");
    try {
      for (const recipient of recipients.map((r) => r.toLowerCase())) {
        if (!written?.has(recipient)) continue;
        stmt.run([sendKey, recipient]);
        written.delete(recipient);
      }
    } finally {
      stmt.free();
    }
    await this.persist();
  }

  /**
   * Uncertain batches of this send, each with the Idempotency-Key it went out
   * with, in the order its addresses were written (the order of the batch).
   */
  uncertainBatches(sendKey: string): Array<{ key: string; recipients: string[] }> {
    const batches = new Map<string, string[]>();
    const stmt = this.db.prepare(
      "SELECT recipient, batch_key FROM sent_recipients WHERE send_key = ? AND state = 'uncertain' AND batch_key IS NOT NULL ORDER BY rowid",
    );
    try {
      stmt.bind([sendKey]);
      while (stmt.step()) {
        const [recipient, key] = stmt.get();
        const list = batches.get(String(key)) ?? [];
        list.push(String(recipient));
        batches.set(String(key), list);
      }
    } finally {
      stmt.free();
    }
    return [...batches].map(([key, recipients]) => ({ key, recipients }));
  }

  /** Clear uncertain addresses SMTPfast showed were never sent, so this run can send them. */
  async releaseUncertain(sendKey: string, recipients: string[]) {
    const stmt = this.db.prepare("DELETE FROM sent_recipients WHERE send_key = ? AND recipient = ? AND state = 'uncertain'");
    try {
      for (const recipient of recipients) stmt.run([sendKey, recipient.toLowerCase()]);
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
        state TEXT NOT NULL DEFAULT 'sent',
        batch_key TEXT,
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
    // History files from before batch keys get the column; old rows keep NULL
    // and so are never replayed.
    const columns = this.db.exec("PRAGMA table_info(sent_recipients)")[0]?.values.map((row) => String(row[1])) ?? [];
    if (!columns.includes("batch_key")) this.db.run("ALTER TABLE sent_recipients ADD COLUMN batch_key TEXT");
  }

  private async persist() {
    if (!this.locked) throw new Error("Feedletter bug: the history file was written outside its lock.");
    // Write a temp file and rename it, so a crash never leaves half a database.
    const temp = `${this.dbPath}.${process.pid}.tmp`;
    await writeFile(temp, Buffer.from(this.db.export()));
    await rename(temp, this.dbPath);
  }
}
