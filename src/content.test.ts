import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadContentDirectory } from "./content.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "feedletter-content-"));
  await writeFile(path.join(dir, "dated.md"), "---\ntitle: Dated\ndate: 2026-05-30\n---\nA self-hosted runner, step by step.");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadContentDirectory", () => {
  it("keeps a YAML date as a plain calendar date", async () => {
    const [item] = await loadContentDirectory({ dir, limit: 5 });
    expect(item.date).toBe("2026-05-30");
    expect(item.summary).toBe("A self-hosted runner, step by step.");
  });

  it("explains a missing directory", async () => {
    await expect(loadContentDirectory({ dir: path.join(dir, "nope"), limit: 5 })).rejects.toThrow(/Content directory not found/);
  });

  it("explains a file passed as the directory", async () => {
    await expect(loadContentDirectory({ dir: path.join(dir, "dated.md"), limit: 5 })).rejects.toThrow(/is a file, not a directory/);
  });
});
