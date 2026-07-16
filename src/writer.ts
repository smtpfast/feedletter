import { spawn } from "node:child_process";
import type { DigestIssue, DigestPatch } from "./types.js";
import { buildDigestPrompt, applyDigestPatch } from "./ai.js";

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
) {
  const parts = splitCommand(command);
  if (parts.length === 0) throw new Error("--agent-command cannot be empty.");

  const prompt = buildDigestPrompt(issue, tone);
  const hasPromptPlaceholder = parts.some((part) => part.includes("{prompt}"));
  const [bin, ...args] = parts.map((part) => part.replaceAll("{prompt}", prompt));

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      env: process.env,
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
  });

  return applyDigestPatch(issue, extractJson(stdout));
}
