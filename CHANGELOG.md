# Changelog

## [Unreleased]

### Security

- Markdown front matter is read as data only. A file that starts with `---js` or `---javascript` used to run its front matter as JavaScript when `build --content` or the studio read the folder; it is now refused with an error naming the file. YAML and JSON front matter work as before.
- The studio API needs a token that is new every time the studio starts. It is printed in the link (`http://127.0.0.1:4180/#token=...`), never written into the page, and sent by the page with every request, so another program or user on the same machine can no longer read your Markdown files or use your AI key or writer through the studio. Open the printed link; a bookmark without the token cannot load or send.
- `send` can store recipients in the history file as keyed hashes (HMAC-SHA256) instead of addresses: set `FEEDLETTER_HISTORY_KEY` to a long random value. Plain addresses already in the file are turned into hashes the next time it is written. Without the key, `send` and the studio warn that addresses are stored in plain text. With hashes in the file, a run without the key, or with another key, stops instead of sending again.
- The GitHub Actions example no longer sends an issue twice after a partly failed send, and no longer commits the subscriber list: it saves the history after every attempt, resumes the unfinished issue, checks out the branch head on a re-run, runs one at a time, pins the Feedletter version, reads recipients from a secret, and says the repository must be private. If you copied the old example, copy it again.
- `--api-key-file <path>` reads the SMTPfast key from a file. `--api-key` is deprecated: other users on the machine can read it in the process list. It still works, with a warning.
- An uncertain batch is replayed only while its first attempt is less than 23 hours old, inside SMTPfast's 24 hour key window. An older one stays uncertain and `send` reports it.
- The external writer (`--agent-command`) runs in an empty temporary folder with only the environment it needs; Feedletter's own keys are not passed to it. Name more variables with the new `--agent-env`. Codex needs `--skip-git-repo-check` there.
- SMTPfast calls never follow redirects. A redirect stops the send as not sent.
- From a public feed, Feedletter no longer follows a redirect or an advertised feed link to a private or local address. A feed is read up to 10 MB, and entities declared in a feed's DOCTYPE are not expanded.
- Emails link only `http(s)` addresses, so a `javascript:` link in front matter or a saved draft is dropped. The studio's email preview is sandboxed, the studio page cannot be framed by another site, and `preview` checks the `Host` and `Origin` headers like the studio does.
- Releases install the locked dependencies (`package-lock.json`) without install scripts, and publish from a separate job that installs nothing.

## [0.5.0] - 2026-10-08

### Added

- `--dailydev <feed>` builds an issue from daily.dev: `popular[:tags]`, `discussed[:tag]`, `tag:<tag>`, `search:<words>`, `foryou` or `bookmarks`. It needs a personal access token in `DAILY_DEV_TOKEN`. Items link to the article, or to the daily.dev discussion with `--dailydev-link discussion`.
- The studio has a daily.dev source when it starts with `DAILY_DEV_TOKEN` set. The token stays on the server. `/?dailydev=<feed>` loads a feed straight away.

### Changed

- The studio's source buttons are now "RSS", "Markdown" and "daily.dev".

## [0.4.0] - 2026-10-04

### Changed

- `send` gives each batch a random `Idempotency-Key`, saved in the history file before the batch goes out. A 5xx or a lost answer is retried twice with the same key, which SMTPfast answers with its first answer, so a retry never sends twice. A refusal after such an attempt counts as uncertain, not as "not sent".
- A rerun replays a batch left uncertain by an earlier run with its key (within SMTPfast's 24 hour window): a batch that went out is marked sent, and one that never did is sent now. Uncertain batches that cannot be replayed are still skipped. `--resend` uses new keys, so it really sends again.
- The history file gets a `batch_key` column on first open. Older uncertain rows have no key and are skipped as before.

## [0.3.1] - 2026-10-03

Published from GitHub Actions with npm trusted publishing, so no npm token is stored anywhere. No code changes.

## [0.3.0] - 2026-10-03

First release on npm: `npm install -g feedletter`.

### Added

- Send to your SMTPfast contacts or one segment as a broadcast, or to a list of addresses through the batch API, 100 per request.
- Feed autodiscovery: paste a blog's home page and Feedletter follows the feed it links to.
- A better studio layout on phones, with errors in a bar you can close.

### Changed

- When Feedletter cannot tell whether a send went out, it stops and reports instead of retrying. Each batch is recorded before it goes out, so a rerun skips addresses that may already have the email. `--resend` sends to everyone again.
- A saved broadcast is reused only while it is still a draft with the same audience, sender and subject.
- Only one send can run at a time per history file.

### Fixed

- HTML entities and CDATA in feeds are decoded once, in the right order.
- Dates with a time keep it; only a bare `YYYY-MM-DD` is treated as a calendar date.
- The studio checks the Host header for every loopback address it binds to.

## [0.2.0] - 2026-07-16

First public version: build a digest from RSS or Markdown, curate it in the studio, and send it with SMTPfast.
