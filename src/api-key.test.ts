import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { API_KEY_FLAG_WARNING, smtpfastKey } from "./api-key.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "feedletter-key-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("smtpfastKey", () => {
  it("reads and trims --api-key-file, so the key never needs to be on the command line", async () => {
    const file = path.join(dir, "key.txt");
    await writeFile(file, "  sf_dummy_from_file\n");
    const warnings: string[] = [];
    expect(await smtpfastKey({ apiKeyFile: file }, { SMTPFAST_API_KEY: "sf_env" }, (m) => warnings.push(m))).toBe("sf_dummy_from_file");
    expect(warnings).toEqual([]);
  });

  it("explains an empty or missing key file", async () => {
    const empty = path.join(dir, "empty.txt");
    await writeFile(empty, "\n");
    await expect(smtpfastKey({ apiKeyFile: empty }, {})).rejects.toThrow(/is empty/);
    await expect(smtpfastKey({ apiKeyFile: path.join(dir, "nope.txt") }, {})).rejects.toThrow(/Could not read the API key file/);
  });

  it("still takes the deprecated --api-key, with a warning", async () => {
    const warnings: string[] = [];
    expect(await smtpfastKey({ apiKey: "sf_dummy_flag" }, {}, (m) => warnings.push(m))).toBe("sf_dummy_flag");
    expect(warnings).toEqual([API_KEY_FLAG_WARNING]);
    expect(API_KEY_FLAG_WARNING).toMatch(/process list/);
  });

  it("falls back to SMTPFAST_API_KEY and refuses two sources", async () => {
    expect(await smtpfastKey({}, { SMTPFAST_API_KEY: " sf_env " })).toBe("sf_env");
    await expect(smtpfastKey({}, {})).rejects.toThrow(/Set SMTPFAST_API_KEY or pass --api-key-file/);
    await expect(smtpfastKey({ apiKey: "a", apiKeyFile: "b" }, {}, () => undefined)).rejects.toThrow(/not both/);
  });
});

describe("send and broadcast options", () => {
  const tsx = createRequire(import.meta.url).resolve("tsx/cli");
  const cli = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [tsx, fileURLToPath(new URL("./cli.ts", import.meta.url)), ...args], {
        env: { PATH: process.env.PATH, ...env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });

  it("documents --api-key-file and marks --api-key as deprecated", async () => {
    for (const command of ["send", "broadcast"]) {
      const { stdout } = await cli([command, "--help"]);
      expect(stdout).toMatch(/--api-key-file <path>/);
      expect(stdout).toMatch(/--api-key <key>\s+Deprecated/);
    }
  }, 30_000);

  it("warns on stderr when --api-key is used, and goes on", async () => {
    const { code, stderr } = await cli(["send", "--from", "news@example.test", "--to", "a@example.test", "--dir", path.join(dir, "no-build"), "--api-key", "sf_dummy_flag"]);
    expect(stderr).toContain(API_KEY_FLAG_WARNING);
    // It got past the key to the next step.
    expect(stderr).toMatch(/No issue\.json/);
    expect(code).toBe(1);
  }, 30_000);
});
