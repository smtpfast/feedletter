---
title: "Markdown folder to a digest"
description: "End-to-end: turn a local Markdown/MDX content folder into a newsletter digest."
date: "2026-08-28"
slug: "markdown-folder-digest"
author: "Feedletter Team"
---

If your content lives as Markdown/MDX files (a blog repo, docs folder, or
team wiki), Feedletter can build the digest straight from the directory —
no RSS feed required.

## 1. Point Feedletter at the content folder

```bash
feedletter build \
  --content ./content/blog \
  --base-url https://example.com \
  --title "Latest from the team" \
  --out dist/digest
```

`--base-url` is used for the links in the email; each Markdown file's frontmatter
(title, date, summary) becomes an item in the digest.

## 2. Curate with the studio

```bash
feedletter studio
```

Just like the RSS path: pick items, reorder, edit the subject and intro, and
preview live. The SQLite history prevents the same post from being included
in two digests.

## 3. Send

One click from the studio with your [SMTPfast](https://smtpfa.st) key. Add
`{{unsubscribe_url}}` to the template so recipients can unsubscribe per
newsletter.
