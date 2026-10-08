# Changelog

## [Unreleased]

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
