---
title: "Hugo/Jekyll/Astro blog RSS to a weekly digest"
description: "End-to-end: turn your static blog's RSS feed into a sent weekly digest with Feedletter."
date: "2026-08-28"
slug: "blog-rss-weekly-digest"
author: "Feedletter Team"
---

Static blogs (Hugo, Jekyll, Astro) all publish an RSS/Atom feed, which is
exactly the structure a weekly digest needs: titles, links, dates, authors,
and summaries.

## 1. Build a draft digest from the feed

```bash
feedletter build \
  --rss https://example.com/index.xml \
  --title "This week's posts" \
  --out dist/weekly
```

Hugo serves `index.xml`, Jekyll serves `feed.xml`, Astro serves `rss.xml` —
point `--rss` at whichever URL your generator emits.

## 2. Curate in the studio

```bash
feedletter studio
```

Pick the items you want, reorder them, tweak the subject and intro, and watch
the live preview. Feedletter tracks history in SQLite, so posts already
included in a previous digest are not sent twice.

## 3. Send with SMTPfast

With your [SMTPfast](https://smtpfa.st) key set, one-click send from the
studio. `{{unsubscribe_url}}` in the template gives every recipient a working
unsubscribe link.
