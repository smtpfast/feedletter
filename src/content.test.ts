import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadContentDirectory } from "./content.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "feedletter-content-"));
  await writeFile(path.join(dir, "dated.md"), "---\ntitle: Dated\ndate: 2026-05-30\n---\nA self-hosted runner, step by step.");
  await writeFile(path.join(dir, "timed.md"), "---\ntitle: Timed\ndate: 2026-05-29T00:00:00Z\n---\nBody.");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadContentDirectory", () => {
  it("keeps a YAML date as a plain calendar date", async () => {
    const items = await loadContentDirectory({ dir, limit: 5 });
    const item = items.find((i) => i.title === "Dated")!;
    expect(item.date).toBe("2026-05-30");
    expect(item.summary).toBe("A self-hosted runner, step by step.");
  });

  it("keeps the time of an unquoted YAML timestamp, midnight included", async () => {
    const items = await loadContentDirectory({ dir, limit: 5 });
    expect(items.find((i) => i.title === "Timed")!.date).toBe("2026-05-29T00:00:00.000Z");
  });

  it("explains a missing directory", async () => {
    await expect(loadContentDirectory({ dir: path.join(dir, "nope"), limit: 5 })).rejects.toThrow(/Content directory not found/);
  });

  it("refuses JavaScript front matter instead of running it", async () => {
    const marker = path.join(dir, "marker.txt");
    // The audit's fixture: evaluating this block writes a marker file.
    const payload = (tag: string) =>
      `---${tag}\n{ title: "computed-" + (6 * 7), marker: require("fs").writeFileSync(${JSON.stringify(marker)}, "evaluated") }\n---\nBody text.\n`;
    for (const tag of ["js", "JS", "javascript", "JavaScript", " js"]) {
      const folder = path.join(dir, `js-${tag.trim()}-${tag.length}`);
      await mkdir(folder);
      await writeFile(path.join(folder, "yaml.md"), "---\ntitle: Plain YAML post\n---\nBody.");
      await writeFile(path.join(folder, "evil.md"), payload(tag));
      await expect(loadContentDirectory({ dir: folder, limit: 5 })).rejects.toThrow(
        /Could not read front matter in .*evil\.md: JavaScript front matter is not supported/,
      );
      expect(existsSync(marker)).toBe(false);
    }
  });

  it("still reads YAML and JSON front matter", async () => {
    const folder = path.join(dir, "data-formats");
    await mkdir(folder);
    await writeFile(path.join(folder, "yaml.md"), "---\ntitle: From YAML\ndate: 2026-05-02\n---\nBody.");
    await writeFile(path.join(folder, "json.md"), '---json\n{ "title": "From JSON", "date": "2026-05-01" }\n---\nBody.');
    const items = await loadContentDirectory({ dir: folder, limit: 5 });
    expect(items.map((item) => item.title)).toEqual(["From YAML", "From JSON"]);
  });

  it("explains a file passed as the directory", async () => {
    await expect(loadContentDirectory({ dir: path.join(dir, "dated.md"), limit: 5 })).rejects.toThrow(/is a file, not a directory/);
  });
});
