# Changelog

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
