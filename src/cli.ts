#!/usr/bin/env node
import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { buildFallbackIssue, enrichIssueWithAi } from "./ai.js";
import { loadContentDirectory } from "./content.js";
import { HistoryStore, itemHistoryKey } from "./history.js";
import { startPreviewServer } from "./preview.js";
import { renderHtml, renderText } from "./render.js";
import { loadRssFeed } from "./rss.js";
import {
  BROADCAST_SENT_STATUSES,
  broadcastUrl,
  checkRecipients,
  createBroadcastOnce,
  findSegment,
  getAudience,
  getBroadcast,
  parseRecipients,
  sendBroadcastChecked,
  sendDigest,
  sendKey,
  SmtpfastError,
  SMTPFAST_DEFAULT_BASE_URL,
  UNSUBSCRIBE_PLACEHOLDER,
  type SendCheckpoint,
} from "./smtpfast.js";
import { startStudioServer } from "./studio.js";
import { requireOneSource, writeOutputFile } from "./utils.js";
import { enrichIssueWithCommand } from "./writer.js";
import type { DigestIssue } from "./types.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const program = new Command();

program
  .name("feedletter")
  .description("Generate email digests from RSS feeds or local Markdown content.")
  .version(version);

async function readIssue(dir: string): Promise<DigestIssue> {
  const file = path.join(path.resolve(dir), "issue.json");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new Error(`No issue.json in ${path.resolve(dir)}. Run feedletter build --out ${dir} first.`);
  }
  try {
    return JSON.parse(raw) as DigestIssue;
  } catch {
    throw new Error(`${file} is not valid JSON.`);
  }
}

function plural(count: number, word: string) {
  return `${count.toLocaleString("en")} ${word}${count === 1 ? "" : "s"}`;
}

program
  .command("build")
  .description("Build email.html, email.txt, and issue.json from a content source.")
  .option("--rss <url>", "RSS or Atom feed URL")
  .option("--content <dir>", "Local Markdown/MDX content directory")
  .option("--base-url <url>", "Base URL for relative Markdown slugs")
  .option("--out <dir>", "Output directory", "dist/feedletter")
  .option("--limit <number>", "Number of items to include", "5")
  .option("--title <title>", "Digest subject/title", "Latest updates")
  .option("--description <text>", "Intro copy before the item list")
  .option("--source-label <label>", "Small label above the title")
  .option("--instructions <file>", "Markdown file with voice, audience, sponsor, or editorial instructions")
  .option("--history-db <path>", "SQLite file used to skip previously included items", ".feedletter/feedletter.sqlite")
  .option("--no-history", "Do not read or write item history")
  .option("--include-seen", "Allow items that already exist in the history DB")
  .option("--no-record-history", "Do not mark generated items as included after a successful build")
  .option("--ai", "Use an OpenAI-compatible chat completions API to improve subject, preheader, and intro")
  .option("--ai-base-url <url>", "AI API base URL", process.env.AI_BASE_URL ?? "https://api.openai.com/v1")
  .option("--ai-model <model>", "AI model name", process.env.AI_MODEL)
  .option("--agent-command <command>", "External writer command. Receives the editorial prompt on stdin and must print JSON.")
  .option("--agent-timeout <ms>", "External writer command timeout", "120000")
  .option("--tone <tone>", "AI writing tone", "clear, useful, developer-friendly")
  .action(async (options) => {
    let history: HistoryStore | undefined;
    try {
      requireOneSource(options.rss, options.content);
      const limit = Number.parseInt(options.limit, 10);
      if (!Number.isFinite(limit) || limit < 1) throw new Error("--limit must be a positive number.");
      if (options.ai && options.agentCommand) {
        throw new Error("Use either --ai or --agent-command, not both.");
      }

      const loadLimit = options.history && !options.includeSeen ? Math.max(limit * 4, limit + 20) : limit;
      const loadedItems = options.rss
        ? await loadRssFeed({ url: options.rss, limit: loadLimit })
        : await loadContentDirectory({
            dir: path.resolve(options.content),
            baseUrl: options.baseUrl,
            limit: loadLimit,
          });

      if (loadedItems.length === 0) throw new Error("No items found.");

      let skippedSeenCount = 0;
      let freshItems = loadedItems;
      if (options.history && !options.includeSeen) {
        history = await HistoryStore.open(path.resolve(options.historyDb));
        const seen = history.seenKeys(loadedItems);
        freshItems = loadedItems.filter((item) => {
          const isSeen = seen.has(itemHistoryKey(item));
          if (isSeen) skippedSeenCount++;
          return !isSeen;
        });
      } else if (options.history) {
        history = await HistoryStore.open(path.resolve(options.historyDb));
      }

      const items = freshItems.slice(0, limit);
      if (items.length === 0) {
        throw new Error("No new items found. Use --include-seen to build from previously included content.");
      }

      const instructions =
        typeof options.instructions === "string"
          ? await readFile(path.resolve(options.instructions), "utf8")
          : undefined;

      const sourceLabel =
        options.sourceLabel ?? (options.rss ? new URL(options.rss).hostname : "Local content");
      const fallback = buildFallbackIssue(
        options.title,
        options.description,
        sourceLabel,
        items,
        instructions,
        skippedSeenCount,
      );
      let issue = await enrichIssueWithAi(fallback, {
        enabled: Boolean(options.ai),
        baseUrl: options.aiBaseUrl,
        apiKey: process.env.OPENAI_API_KEY ?? process.env.AI_API_KEY,
        model: options.aiModel,
        tone: options.tone,
      });
      if (options.agentCommand) {
        const timeoutMs = Number.parseInt(options.agentTimeout, 10);
        if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
          throw new Error("--agent-timeout must be at least 1000ms.");
        }
        issue = await enrichIssueWithCommand(issue, options.agentCommand, options.tone, timeoutMs);
      }

      const outDir = path.resolve(options.out);
      await writeOutputFile(outDir, "email.html", renderHtml(issue));
      await writeOutputFile(outDir, "email.txt", renderText(issue));
      await writeOutputFile(outDir, "issue.json", `${JSON.stringify(issue, null, 2)}\n`);

      if (history && options.recordHistory) {
        await history.recordIssue(issue);
      }

      const skippedText = skippedSeenCount ? ` (${skippedSeenCount} previously included item${skippedSeenCount === 1 ? "" : "s"} skipped)` : "";
      console.log(`Generated ${items.length} item digest in ${outDir}${skippedText}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    } finally {
      history?.close();
    }
  });

program
  .command("preview")
  .description("Start a local browser preview for a generated Feedletter output directory.")
  .option("--dir <dir>", "Directory containing email.html, email.txt, and issue.json", "dist/feedletter")
  .option("--host <host>", "Host to bind", "127.0.0.1")
  .option("--port <number>", "Port to bind", "4173")
  .action(async (options) => {
    try {
      const port = Number.parseInt(options.port, 10);
      if (!Number.isFinite(port) || port < 1) throw new Error("--port must be a positive number.");
      await startPreviewServer({
        dir: path.resolve(options.dir),
        host: options.host,
        port,
      });
      console.log(`Feedletter preview running at http://${options.host}:${port}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

program
  .command("studio")
  .description("Open the browser studio to curate items, edit copy, preview, and send with SMTPfast.")
  .option("--host <host>", "Host to bind", "127.0.0.1")
  .option("--port <number>", "Port to bind", "4180")
  .option("--content <dir>", "Default local Markdown/MDX content directory")
  .option("--base-url <url>", "Default base URL for relative Markdown slugs")
  .option("--from <email>", "Default sender address for the send panel")
  .option("--history-db <path>", "SQLite file used to flag and skip previously sent items", ".feedletter/feedletter.sqlite")
  .option("--no-history", "Do not track or flag previously sent items")
  .option("--agent-command <command>", "Use an external writer (e.g. \"claude -p\" or \"codex\") for Improve, instead of the AI API")
  .option("--agent-timeout <ms>", "External writer command timeout", "120000")
  .action(async (options) => {
    try {
      const port = Number.parseInt(options.port, 10);
      if (!Number.isFinite(port) || port < 1) throw new Error("--port must be a positive number.");
      const agentTimeoutMs = Number.parseInt(options.agentTimeout, 10);
      if (options.agentCommand && (!Number.isFinite(agentTimeoutMs) || agentTimeoutMs < 1000)) {
        throw new Error("--agent-timeout must be at least 1000ms.");
      }
      await startStudioServer({
        host: options.host,
        port,
        contentDir: options.content,
        baseUrl: options.baseUrl,
        defaultFrom: options.from,
        historyDb: options.historyDb,
        history: options.history,
        agentCommand: options.agentCommand,
        agentTimeoutMs,
      });
      console.log(`Feedletter Studio running at http://${options.host}:${port}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

program
  .command("send")
  .description("Send a built issue with SMTPfast. Reads issue.json from a build output directory.")
  .requiredOption("--from <email>", 'Verified sender, e.g. "Weekly <news@yourdomain.com>"')
  .option("--dir <dir>", "Build output directory containing issue.json", "dist/feedletter")
  .option("--to <list>", "Recipients, comma/space/newline separated")
  .option("--to-file <path>", "File with one recipient per line (# comments allowed)")
  .option("--footer <text>", "Footer note shown above the unsubscribe link")
  .option("--api-key <key>", "SMTPfast API key (defaults to SMTPFAST_API_KEY)")
  .option("--api-url <url>", "SMTPfast API base URL", process.env.SMTPFAST_API_URL ?? SMTPFAST_DEFAULT_BASE_URL)
  .option("--test", "Send only to the first recipient and skip history")
  .option("--resend", "Send to every recipient, even ones an earlier run of this exact issue reached")
  .option("--history-db <path>", "SQLite file used to record sent items and send progress", ".feedletter/feedletter.sqlite")
  .option("--no-history", "Do not record sent items or send progress")
  .action(async (options) => {
    let history: HistoryStore | undefined;
    try {
      const apiKey = options.apiKey ?? process.env.SMTPFAST_API_KEY;
      if (!apiKey) throw new Error("Provide --api-key or set SMTPFAST_API_KEY.");

      const issue = await readIssue(options.dir);

      let recipients: string[] = [];
      if (options.toFile) {
        const fileText = await readFile(path.resolve(options.toFile), "utf8");
        recipients = parseRecipients(
          fileText
            .split(/\r?\n/)
            .filter((line) => !line.trim().startsWith("#"))
            .join("\n"),
        );
      }
      if (options.to) recipients = recipients.concat(parseRecipients(options.to));
      if (recipients.length === 0) throw new Error("Provide --to or --to-file with at least one recipient.");
      if (options.test) recipients = recipients.slice(0, 1);
      const checked = checkRecipients(recipients);
      if (checked.invalid.length > 0) {
        console.error(`Skipping ${plural(checked.invalid.length, "invalid address")}: ${checked.invalid.slice(0, 10).join(", ")}${checked.invalid.length > 10 ? ", ..." : ""}`);
      }
      if (checked.valid.length === 0) throw new Error("No valid recipients to send to.");

      // Re-render with the unsubscribe placeholder so every recipient gets a
      // working one-click unsubscribe (SMTPfast substitutes it per recipient).
      const sendable: DigestIssue = {
        ...issue,
        unsubscribeUrl: UNSUBSCRIBE_PLACEHOLDER,
        footerNote: options.footer ?? issue.footerNote,
      };
      const html = renderHtml(sendable);
      const text = renderText(sendable);
      const message = { from: options.from, subject: issue.title, html, text };

      // The batch endpoint has no idempotency: if a later batch fails, a rerun
      // would resend the earlier ones. The checkpoint records accepted
      // addresses after each batch so a rerun of this exact send skips them.
      let checkpoint: SendCheckpoint | undefined;
      if (options.history && !options.test) {
        history = await HistoryStore.open(path.resolve(options.historyDb));
        const store = history;
        const key = sendKey(message);
        checkpoint = {
          alreadySent: options.resend ? new Set() : store.sentRecipients(key),
          record: (accepted) => store.recordRecipients(key, accepted),
        };
      }

      const results = await sendDigest({ apiKey, baseUrl: options.apiUrl }, message, checked.valid, { checkpoint });
      const sent = results.filter((r) => r.ok).length;
      const suppressed = results.filter((r) => r.suppressed);
      const alreadySent = results.filter((r) => r.alreadySent);
      const failures = results.filter((r) => !r.ok && !r.suppressed && !r.alreadySent);

      if (history && (sent > 0 || alreadySent.length > 0)) await history.recordIssue(issue);

      const skippedText =
        (alreadySent.length ? `, skipped ${alreadySent.length} already sent by an earlier run (--resend sends to them again)` : "") +
        (suppressed.length ? `, skipped ${suppressed.length} suppressed` : "");
      console.log(`${options.test ? "Test sent" : "Sent"} to ${sent}${skippedText}, failed ${failures.length}.`);
      if (suppressed.length) console.log(`  Suppressed (unsubscribed, bounced, or complained before): ${suppressed.map((r) => r.recipient).join(", ")}`);
      for (const failure of failures) console.error(`  ${failure.recipient}: ${failure.error}`);
      if (failures.length > 0) process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    } finally {
      history?.close();
    }
  });

program
  .command("broadcast")
  .description("Send a built issue to your SMTPfast contacts (or one segment) as a broadcast. Creates a draft unless --send is given.")
  .requiredOption("--from <email>", 'Verified sender, e.g. "Weekly <news@yourdomain.com>"')
  .option("--dir <dir>", "Build output directory containing issue.json", "dist/feedletter")
  .option("--segment <id-or-name>", "Send to one SMTPfast segment instead of all contacts")
  .option("--name <name>", "Broadcast name shown in SMTPfast (defaults to the subject)")
  .option("--footer <text>", "Footer note shown above the unsubscribe link")
  .option("--send", "Send now. Without it, Feedletter creates a draft to review and send in SMTPfast")
  .option("--resend", "Create a new broadcast even if this exact issue was already broadcast")
  .option("--api-key <key>", "SMTPfast API key (defaults to SMTPFAST_API_KEY)")
  .option("--api-url <url>", "SMTPfast API base URL", process.env.SMTPFAST_API_URL ?? SMTPFAST_DEFAULT_BASE_URL)
  .option("--history-db <path>", "SQLite file used to record sent items and the broadcast id", ".feedletter/feedletter.sqlite")
  .option("--no-history", "Do not record sent items or the broadcast id")
  .action(async (options) => {
    let history: HistoryStore | undefined;
    try {
      const apiKey = options.apiKey ?? process.env.SMTPFAST_API_KEY;
      if (!apiKey) throw new Error("Provide --api-key or set SMTPFAST_API_KEY.");
      const config = { apiKey, baseUrl: options.apiUrl };
      const issue = await readIssue(options.dir);

      let segmentId: string | undefined;
      let audienceLabel = "all contacts";
      if (options.segment || options.send) {
        const all = await getAudience(config);
        if (options.segment) {
          const segment = findSegment(all.segments, options.segment);
          if (!segment) {
            const names = all.segments.map((s) => `${s.name} (${s.id})`).join(", ");
            throw new Error(`No segment matches "${options.segment}". ${names ? `Segments on this account: ${names}.` : "This account has no segments."}`);
          }
          segmentId = segment.id;
          audienceLabel = `segment "${segment.name}"`;
        }
        if (options.send) {
          const audience = segmentId ? await getAudience(config, segmentId) : all;
          if (audience.eligible === 0) {
            throw new Error(`No subscribed contacts to send to in ${audienceLabel}. Add contacts in SMTPfast first.`);
          }
          if (audience.broadcastLimit !== undefined && audience.broadcastsUsed !== undefined && audience.broadcastsUsed >= audience.broadcastLimit) {
            throw new Error(
              `This plan includes ${plural(audience.broadcastLimit, "broadcast")} a month and ${audience.broadcastsUsed} have been used. Upgrade in SMTPfast or use feedletter send for a recipient list.`,
            );
          }
          console.log(`Audience: ${plural(audience.eligible, "contact")} (${audienceLabel})${audience.skipped ? ` (${audience.skipped} skipped: unsubscribed, suppressed, or invalid)` : ""}.`);
        }
      }

      const sendable: DigestIssue = {
        ...issue,
        unsubscribeUrl: UNSUBSCRIBE_PLACEHOLDER,
        footerNote: options.footer ?? issue.footerNote,
      };
      const html = renderHtml(sendable);
      const text = renderText(sendable);
      const key = `broadcast:${segmentId ?? "all"}:${sendKey({ from: options.from, subject: issue.title, html, text })}`;
      if (options.history) history = await HistoryStore.open(path.resolve(options.historyDb));

      // A lost answer must not lead to a second campaign: reuse the broadcast an
      // earlier run created for this exact issue, after checking its status.
      let broadcastId = options.resend ? undefined : history?.broadcastFor(key);
      if (broadcastId) {
        let existing;
        try {
          existing = await getBroadcast(config, broadcastId);
        } catch (error) {
          if (!(error instanceof SmtpfastError && error.status === 404)) throw error;
        }
        if (existing && BROADCAST_SENT_STATUSES.has(existing.status)) {
          console.log(`This issue was already broadcast (${existing.status}): ${existing.url}`);
          console.log("Nothing sent. Use --resend to send it again as a new broadcast.");
          return;
        }
        if (existing?.status === "draft") {
          console.log(`Using draft broadcast ${broadcastId} from an earlier run.`);
        } else {
          broadcastId = undefined;
        }
      }
      if (!broadcastId) {
        const draft = await createBroadcastOnce(config, {
          name: options.name ?? issue.title,
          from: options.from,
          subject: issue.title,
          previewText: issue.preheader,
          html,
          text,
          segmentId,
        });
        broadcastId = draft.id;
        await history?.recordBroadcast(key, draft.id);
        console.log(`Created draft broadcast ${draft.id} for ${audienceLabel}.`);
      }

      if (!options.send) {
        console.log(`Review and send it in SMTPfast: ${broadcastUrl(broadcastId)}`);
        console.log("Or rerun with --send to send it now.");
        return;
      }

      const sent = await sendBroadcastChecked(config, broadcastId);
      if (history) await history.recordIssue(issue);
      const count = sent.recipients !== undefined ? ` to ${plural(sent.recipients, "contact")}` : "";
      const recovered = sent.recovered ? " (the answer to the send was lost; SMTPfast shows it as sent)" : "";
      console.log(`Broadcast ${sent.status}${count}${recovered}. Track it at ${sent.url}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    } finally {
      history?.close();
    }
  });

program.parseAsync();
