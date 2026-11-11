import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DigestIssue, DigestPatch } from "./types.js";
import { buildDigestPrompt, applyDigestPatch } from "./ai.js";

/**
 * The variables a writer command gets: what it needs to run and to find its
 * own login and settings. Feedletter's keys (SMTPFAST_API_KEY, DAILY_DEV_TOKEN,
 * OPENAI_API_KEY, AI_API_KEY, FEEDLETTER_HISTORY_KEY) and anything else stay out,
 * because the prompt holds feed text that Feedletter does not control.
 */
const WRITER_ENV = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TZ", "TERM",
  "TMPDIR", "TMP", "TEMP",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "SYSTEMROOT", "COMSPEC", "PATHEXT", "WINDIR", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "PROGRAMDATA",
  // Where Claude Code and Codex keep their login and settings.
  "CLAUDE_CONFIG_DIR", "CODEX_HOME",
];

export interface WriterOptions {
  /** More environment variables to pass by name, such as the writer's own API key. */
  env?: string[];
}

/** Parse a --agent-env value: names separated by commas or spaces. */
export function parseEnvNames(value: string | undefined): string[] {
  const names = (value ?? "").split(/[\s,]+/).filter(Boolean);
  const bad = names.find((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
  if (bad) throw new Error(`--agent-env takes variable names, not values: "${bad}" is not a name.`);
  return names;
}

function writerEnv(extra: string[] = [], source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [...WRITER_ENV, ...extra]) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * The writer runs in an empty temporary folder, so a relative path in the
 * command (a script next to your content) is made absolute from where
 * Feedletter was started. Only words that look like paths and exist are changed.
 */
function absolutePaths(parts: string[]) {
  return parts.map((part) =>
    !part.startsWith("-") && !path.isAbsolute(part) && /[\\/]/.test(part) && existsSync(part) ? path.resolve(part) : part,
  );
}

function splitCommand(command: string) {
  const parts: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command))) {
    parts.push((match[1] ?? match[2] ?? match[3]).replace(/\\(["'])/g, "$1"));
  }
  return parts;
}

function extractJson(stdout: string): DigestPatch {
  const trimmed = stdout.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Writer command did not return a JSON object.");
  }
  return JSON.parse(trimmed.slice(start, end + 1)) as DigestPatch;
}

export async function enrichIssueWithCommand(
  issue: DigestIssue,
  command: string,
  tone: string,
  timeoutMs: number,
  options: WriterOptions = {},
) {
  const parts = absolutePaths(splitCommand(command));
  if (parts.length === 0) throw new Error("--agent-command cannot be empty.");

  const prompt = buildDigestPrompt(issue, tone);
  const hasPromptPlaceholder = parts.some((part) => part.includes("{prompt}"));
  const [bin, ...args] = parts.map((part) => part.replaceAll("{prompt}", prompt));

  const workDir = await mkdtemp(path.join(tmpdir(), "feedletter-writer-"));
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      cwd: workDir,
      env: writerEnv(options.env),
    });
    let out = "";
    let err = "";

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Writer command timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`Writer command exited with ${code}: ${err || out}`));
    });

    if (!hasPromptPlaceholder) child.stdin.end(prompt);
    else child.stdin.end();
  }).finally(() => rm(workDir, { recursive: true, force: true }));

  return applyDigestPatch(issue, extractJson(stdout));
}
