import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (file: string) => readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8");

/** The text of one step or job: from its "- name:" or "<id>:" line to the next one at the same indent. */
function block(text: string, header: RegExp) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => header.test(line));
  if (start === -1) return "";
  const indent = lines[start].search(/\S/);
  const end = lines.findIndex((line, i) => i > start && line.trim() !== "" && line.search(/\S/) <= indent && !line.trim().startsWith("#"));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

describe("the GitHub Actions newsletter example", () => {
  const workflow = read("examples/github-actions-newsletter.yml");
  const save = block(workflow, /- name: Save send history/);
  const send = block(workflow, /- name: Send with SMTPfast/);
  const build = block(workflow, /- name: Build the issue/);

  it("saves the history after a failed send too", () => {
    expect(save).toMatch(/if: always\(\) && steps\.issue\.outputs\.ready == 'true'/);
  });

  it("checks out the branch head, so a re-run sees what the failed run sent", () => {
    expect(block(workflow, /- uses: actions\/checkout/)).toMatch(/ref: \$\{\{ github\.ref \}\}/);
  });

  it("resends the unfinished issue instead of building a new one", () => {
    expect(build).toMatch(/if \[ -f dist\/newsletter\/issue\.json \]; then/);
    expect(save).toMatch(/git add -f dist\/newsletter/);
    expect(save).toMatch(/git rm -r -q --cached --ignore-unmatch dist\/newsletter/);
  });

  it("runs one at a time and pins the Feedletter version", () => {
    expect(workflow).toMatch(/^concurrency:\n {2}group: .+\n {2}cancel-in-progress: false$/m);
    expect(workflow).not.toMatch(/feedletter@latest/);
    expect(workflow).toMatch(/FEEDLETTER_VERSION: "\d+\.\d+\.\d+"/);
    expect(workflow.match(/npx --yes "feedletter@\$FEEDLETTER_VERSION"/g)).toHaveLength(2);
  });

  it("keeps the recipient list out of the repository and hashes it in the history", () => {
    expect(workflow).not.toMatch(/--to-file recipients\.txt/);
    expect(send).toMatch(/NEWSLETTER_RECIPIENTS: \$\{\{ secrets\.NEWSLETTER_RECIPIENTS \}\}/);
    expect(send).toMatch(/recipients="\$RUNNER_TEMP\/recipients\.txt"/);
    expect(send).toMatch(/FEEDLETTER_HISTORY_KEY: \$\{\{ secrets\.FEEDLETTER_HISTORY_KEY \}\}/);
    expect(save).not.toMatch(/recipients/);
  });

  it("says the repository must be private", () => {
    expect(workflow.slice(0, 600)).toMatch(/Run it in a PRIVATE repository/);
  });
});

describe("the release workflow", () => {
  const workflow = read(".github/workflows/release.yml");
  const buildJob = block(workflow, /^ {2}build:/);
  const publishJob = block(workflow, /^ {2}publish:/);

  it("installs the locked dependencies without their install scripts", () => {
    expect(existsSync(fileURLToPath(new URL("../package-lock.json", import.meta.url)))).toBe(true);
    expect(buildJob).toMatch(/npm ci --ignore-scripts/);
    const installs = workflow.split("\n").filter((l) => /^\s*(-\s+)?(run:\s+)?npm (ci|install)\b/.test(l));
    expect(installs.length).toBeGreaterThanOrEqual(3);
    for (const line of installs) expect(line).toMatch(/--ignore-scripts/);
  });

  it("publishes from a job that installs nothing from the project and holds the only npm identity", () => {
    expect(workflow).toMatch(/^permissions: \{\}$/m);
    expect(publishJob).toMatch(/id-token: write/);
    expect(publishJob).not.toMatch(/actions\/checkout|npm ci|npm run|npm test/);
    expect(publishJob).toMatch(/npm publish "\.\/feedletter-\$VERSION\.tgz"/);
    expect(buildJob).not.toMatch(/id-token/);
    expect(buildJob).toMatch(/persist-credentials: false/);
    expect(workflow).not.toMatch(/NPM_TOKEN/);
    expect(workflow).not.toMatch(/npm@\^/);
  });

  it("is matched by CI, which also installs without scripts", () => {
    expect(read(".github/workflows/ci.yml")).toMatch(/npm ci --ignore-scripts/);
  });
});
