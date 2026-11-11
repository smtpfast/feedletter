import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash, createHmac } from "node:crypto";
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

/** The environment variable that holds the key for recipient hashes in the history file. */
export const HISTORY_KEY_ENV = "FEEDLETTER_HISTORY_KEY";
const MIN_HISTORY_KEY_LENGTH = 16;
const HASH_PREFIX = "hmac:";
const KEY_CHECK_NAME = "recipient_key_check";

/**
 * The recipient key from the environment, or undefined when it is not set
 * (an empty value, as GitHub Actions gives for a missing secret, counts as not set).
 */
export function historyKeyFrom(value: string | undefined): string | undefined {
  const key = value?.trim();
  if (!key) return undefined;
  if (key.length < MIN_HISTORY_KEY_LENGTH) {
    throw new Error(`${HISTORY_KEY_ENV} must be at least ${MIN_HISTORY_KEY_LENGTH} characters. Create one with: openssl rand -hex 32`);
  }
  return key;
}

export const PLAIN_RECIPIENTS_WARNING =
  `Warning: ${HISTORY_KEY_ENV} is not set, so the history file stores recipient addresses in plain text. ` +
  "Set it to store keyed hashes instead, and never commit the history file to a public repository.";

export interface HistoryOpenOptions {
  /**
   * Store recipients as HMAC-SHA256(key, address) instead of the address. The
   * same key must be used on every run, or Feedletter cannot tell who was sent to.
   */
  recipientKey?: string;
}

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
  /**
   * What the current batch's write-ahead did, per send key: rows it created,
   * and uncertain rows it gave the new key (with the key they had before).
   */
  private writtenAhead = new Map<string, { written: Set<string>; rekeyed: Map<string, { batchKey: string | null; sentAt: string }> }>();
  /** Plain addresses were turned into hashes in memory and are not on disk yet. */
  private hashedInMemory = false;

  private constructor(
    private readonly dbPath: string,
    private readonly SQL: SqlJsStatic,
    private db: Database,
    private readonly recipientKey?: string,
  ) {}

  static async open(dbPath: string, options: HistoryOpenOptions = {}) {
    const recipientKey = historyKeyFrom(options.recipientKey);
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
    const store = new HistoryStore(dbPath, SQL, db, recipientKey);
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
      // Addresses from a file written without the key leave the file now.
      if (this.hashedInMemory) await this.persist();
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

  /**
   * The value stored for an address: the lowercased address, or its keyed
   * hash when the store has a recipient key.
   */
  private stored(address: string) {
    const lower = address.toLowerCase();
    return this.recipientKey ? `${HASH_PREFIX}${createHmac("sha256", this.recipientKey).update(lower).digest("hex")}` : lower;
  }

  /** Maps stored values back to the lowercased addresses of this run's list. */
  private resolver(recipients: string[]) {
    this.assertRecipientsReadable();
    const known = new Map(recipients.map((recipient) => [this.stored(recipient), recipient.toLowerCase()]));
    // A stored value that is not on this run's list stays as it is, so it never matches an address.
    return (value: unknown) => known.get(String(value)) ?? String(value);
  }

  /**
   * Stop before a send when the history cannot be matched to addresses: a
   * send that cannot tell who already has the email would send it again.
   */
  private assertRecipientsReadable() {
    const check = this.keyCheck();
    if (!this.recipientKey) {
      if (check !== undefined || this.hasHashedRecipients()) {
        throw new Error(
          `This history file stores recipients as keyed hashes. Set ${HISTORY_KEY_ENV} to the key it was written with. Without it Feedletter cannot tell who already has this email, so it does not send.`,
        );
      }
      return;
    }
    if (check !== undefined ? check !== this.expectedKeyCheck() : this.hasHashedRecipients()) {
      throw new Error(
        `${HISTORY_KEY_ENV} is not the key this history file was written with. Feedletter cannot tell who already has this email, so it does not send. Use the original key.`,
      );
    }
  }

  private expectedKeyCheck() {
    return createHmac("sha256", this.recipientKey ?? "").update("feedletter recipient key check").digest("hex");
  }

  private keyCheck(): string | undefined {
    const rows = this.db.exec("SELECT value FROM feedletter_meta WHERE name = ?", [KEY_CHECK_NAME]);
    const value = rows[0]?.values[0]?.[0];
    return value === undefined || value === null ? undefined : String(value);
  }

  private hasHashedRecipients() {
    const rows = this.db.exec("SELECT 1 FROM sent_recipients WHERE recipient LIKE ? LIMIT 1", [`${HASH_PREFIX}%`]);
    return rows.length > 0 && rows[0].values.length > 0;
  }

  /**
   * Addresses on this run's list (lowercased) that an earlier run of this
   * exact send (see sendKey) sent, or may have sent.
   */
  sentRecipients(sendKey: string, recipients: string[]) {
    const resolve = this.resolver(recipients);
    const sent = new Map<string, RecipientState>();
    const stmt = this.db.prepare("SELECT recipient, state FROM sent_recipients WHERE send_key = ?");
    try {
      stmt.bind([sendKey]);
      while (stmt.step()) {
        const [recipient, state] = stmt.get();
        sent.set(resolve(recipient), state === "uncertain" ? "uncertain" : "sent");
      }
    } finally {
      stmt.free();
    }
    return sent;
  }

  /**
   * Save the addresses of one batch, so a rerun of the same send skips them.
   * Writing ahead as uncertain creates rows for new addresses and gives an
   * uncertain address (sent again with --resend) the new batch's key, which a
   * refused batch puts back (see forgetRecipients). It never touches a sent
   * row, so a refused --resend cannot erase what an earlier run sent.
   */
  async recordRecipients(
    sendKey: string,
    rows: Array<{ recipient: string; id?: string }>,
    state: RecipientState = "sent",
    batchKey?: string,
  ) {
    this.assertRecipientsReadable();
    const now = new Date().toISOString();
    if (state === "uncertain") {
      // Batches go one at a time, so these only ever describe the current batch.
      const written = new Set<string>();
      const rekeyed = new Map<string, { batchKey: string | null; sentAt: string }>();
      const find = this.db.prepare("SELECT state, batch_key, sent_at FROM sent_recipients WHERE send_key = ? AND recipient = ?");
      const insert = this.db.prepare(
        "INSERT INTO sent_recipients (send_key, recipient, email_id, sent_at, state, batch_key) VALUES (?, ?, NULL, ?, 'uncertain', ?)",
      );
      // A new key starts a new attempt, so the age of a replay counts from now.
      const rekey = this.db.prepare("UPDATE sent_recipients SET batch_key = ?, sent_at = ? WHERE send_key = ? AND recipient = ?");
      try {
        for (const row of rows) {
          const recipient = this.stored(row.recipient);
          find.bind([sendKey, recipient]);
          const existing = find.step() ? find.get() : null;
          find.reset();
          if (!existing) {
            insert.run([sendKey, recipient, now, batchKey ?? null]);
            written.add(recipient);
          } else if (existing[0] === "uncertain") {
            rekeyed.set(recipient, { batchKey: existing[1] === null ? null : String(existing[1]), sentAt: String(existing[2]) });
            rekey.run([batchKey ?? null, now, sendKey, recipient]);
          }
        }
      } finally {
        find.free();
        insert.free();
        rekey.free();
      }
      this.writtenAhead.set(sendKey, { written, rekeyed });
    } else {
      const stmt = this.db.prepare(
        "INSERT OR REPLACE INTO sent_recipients (send_key, recipient, email_id, sent_at, state, batch_key) VALUES (?, ?, ?, ?, ?, ?)",
      );
      const pending = this.writtenAhead.get(sendKey);
      try {
        for (const row of rows) {
          const recipient = this.stored(row.recipient);
          stmt.run([sendKey, recipient, row.id ?? null, now, state, batchKey ?? null]);
          pending?.written.delete(recipient);
          pending?.rekeyed.delete(recipient);
        }
      } finally {
        stmt.free();
      }
    }
    await this.persist();
  }

  /**
   * Remove addresses written ahead of a batch that SMTPfast then refused (a
   * 4xx: nothing was queued). Only rows the write-ahead created are removed;
   * rows from earlier runs stay as they were.
   */
  async forgetRecipients(sendKey: string, recipients: string[]) {
    const pending = this.writtenAhead.get(sendKey);
    const remove = this.db.prepare("DELETE FROM sent_recipients WHERE send_key = ? AND recipient = ?");
    const restore = this.db.prepare("UPDATE sent_recipients SET batch_key = ?, sent_at = ? WHERE send_key = ? AND recipient = ?");
    try {
      for (const recipient of recipients.map((r) => this.stored(r))) {
        const earlier = pending?.rekeyed.get(recipient);
        if (pending?.written.has(recipient)) {
          remove.run([sendKey, recipient]);
          pending.written.delete(recipient);
        } else if (pending && earlier) {
          // The refused batch sent nothing, so the earlier attempt's key (and its age) is the one that counts.
          restore.run([earlier.batchKey, earlier.sentAt, sendKey, recipient]);
          pending.rekeyed.delete(recipient);
        }
      }
    } finally {
      remove.free();
      restore.free();
    }
    await this.persist();
  }

  /**
   * Uncertain batches of this send, each with the Idempotency-Key it went out
   * with and when that attempt started, in the order its addresses were
   * written (the order of the batch). Addresses are resolved against this
   * run's list; one that is not on it never matches an address.
   */
  uncertainBatches(sendKey: string, recipients: string[]): Array<{ key: string; recipients: string[]; startedAt: string }> {
    const resolve = this.resolver(recipients);
    const batches = new Map<string, { recipients: string[]; startedAt: string }>();
    const stmt = this.db.prepare(
      "SELECT recipient, batch_key, sent_at FROM sent_recipients WHERE send_key = ? AND state = 'uncertain' AND batch_key IS NOT NULL ORDER BY rowid",
    );
    try {
      stmt.bind([sendKey]);
      while (stmt.step()) {
        const [recipient, key, sentAt] = stmt.get();
        const batch = batches.get(String(key)) ?? { recipients: [], startedAt: String(sentAt) };
        batch.recipients.push(resolve(recipient));
        // The oldest write of the batch is when its key was first used.
        if (String(sentAt) < batch.startedAt) batch.startedAt = String(sentAt);
        batches.set(String(key), batch);
      }
    } finally {
      stmt.free();
    }
    return [...batches].map(([key, batch]) => ({ key, ...batch }));
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

      CREATE TABLE IF NOT EXISTS feedletter_meta (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS included_items_issue_key_idx ON included_items(issue_key);
      CREATE INDEX IF NOT EXISTS included_items_included_at_idx ON included_items(included_at);
    `);
    // History files from before batch keys get the column; old rows keep NULL
    // and so are never replayed.
    const columns = this.db.exec("PRAGMA table_info(sent_recipients)")[0]?.values.map((row) => String(row[1])) ?? [];
    if (!columns.includes("batch_key")) this.db.run("ALTER TABLE sent_recipients ADD COLUMN batch_key TEXT");
    this.hashPlainRecipients();
  }

  /**
   * With a recipient key, replace plain addresses (from a file written without
   * the key, or by Feedletter 0.5 and older) with their keyed hashes, in memory.
   * The next write under the lock saves them. A file written with another key
   * is left alone; sends stop on it (see assertRecipientsReadable).
   */
  private hashPlainRecipients() {
    this.hashedInMemory = false;
    if (!this.recipientKey) return;
    const check = this.keyCheck();
    if (check !== undefined && check !== this.expectedKeyCheck()) return;
    if (check === undefined && this.hasHashedRecipients()) return;
    if (check === undefined) {
      this.db.run("INSERT INTO feedletter_meta (name, value) VALUES (?, ?)", [KEY_CHECK_NAME, this.expectedKeyCheck()]);
      this.hashedInMemory = true;
    }
    const plain = this.db.exec("SELECT rowid, send_key, recipient, email_id, sent_at, state, batch_key FROM sent_recipients WHERE recipient LIKE '%@%' ORDER BY rowid");
    for (const [rowid, sendKey, recipient, emailId, sentAt, state, batchKey] of plain[0]?.values ?? []) {
      const hashed = this.stored(String(recipient));
      const existing = this.db.exec("SELECT state FROM sent_recipients WHERE send_key = ? AND recipient = ?", [sendKey, hashed])[0]?.values[0];
      if (!existing) {
        // Same row, so the batch order (rowid) of an uncertain batch is kept.
        this.db.run("UPDATE sent_recipients SET recipient = ? WHERE rowid = ?", [hashed, rowid]);
      } else {
        // Both forms exist: "sent" wins, since that address has the email.
        if (state === "sent" && existing[0] !== "sent") {
          this.db.run("UPDATE sent_recipients SET state = 'sent', email_id = ?, sent_at = ?, batch_key = ? WHERE send_key = ? AND recipient = ?", [
            emailId,
            sentAt,
            batchKey,
            sendKey,
            hashed,
          ]);
        }
        this.db.run("DELETE FROM sent_recipients WHERE rowid = ?", [rowid]);
      }
      this.hashedInMemory = true;
    }
  }

  private async persist() {
    if (!this.locked) throw new Error("Feedletter bug: the history file was written outside its lock.");
    // Write a temp file and rename it, so a crash never leaves half a database.
    const temp = `${this.dbPath}.${process.pid}.tmp`;
    await writeFile(temp, Buffer.from(this.db.export()));
    await rename(temp, this.dbPath);
  }
}
