import type { DigestIssue, SourceItem } from "./types.js";

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

function readingHost(item: SourceItem) {
  if (!item.url) return "";
  try {
    return new URL(item.url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function renderItem(item: SourceItem) {
  const title = escapeHtml(item.title);
  const summary = item.summary ? escapeHtml(item.summary) : "";
  const date = formatDate(item.date);
  const host = readingHost(item);
  const meta = [date, item.author, host].filter(Boolean).join(" · ");
  const titleHtml = item.url
    ? `<a href="${escapeHtml(item.url)}" style="color:#111827;text-decoration:none;">${title}</a>`
    : title;

  return `
    <tr>
      <td style="padding:0 0 14px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e5e7eb;border-radius:16px;background:#ffffff;">
          <tr>
            <td style="padding:20px 20px 18px;">
              ${meta ? `<div style="margin-bottom:10px;font-size:12px;line-height:18px;color:#64748b;">${escapeHtml(meta)}</div>` : ""}
              <h2 style="margin:0 0 9px;font-size:20px;line-height:28px;color:#111827;font-weight:800;">${titleHtml}</h2>
              ${summary ? `<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:#475569;">${summary}</p>` : ""}
              ${
                item.url
                  ? `<table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="border-radius:999px;background:#0f766e;"><a href="${escapeHtml(item.url)}" style="display:inline-block;padding:9px 14px;font-size:13px;line-height:18px;color:#ffffff;font-weight:700;text-decoration:none;">Read the post</a></td></tr></table>`
                  : ""
              }
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

export function renderHtml(issue: DigestIssue) {
  const title = escapeHtml(issue.title);
  const preheader = escapeHtml(issue.preheader);
  const intro = escapeHtml(issue.intro);

  const generated = escapeHtml(formatDate(issue.generatedAt));
  const itemCount = `${issue.items.length} item${issue.items.length === 1 ? "" : "s"}`;

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
  </head>
  <body style="margin:0;padding:0;background:#eef2f7;font-family:Arial,Helvetica,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${preheader}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#eef2f7;">
      <tr>
        <td align="center" style="padding:28px 14px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;">
            <tr>
              <td style="padding:0 0 14px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="overflow:hidden;border-radius:22px;background:#0f172a;">
                  <tr>
                    <td style="padding:8px;background:#14b8a6;"></td>
                  </tr>
                  <tr>
                    <td style="padding:34px 30px 30px;">
                      <div style="margin-bottom:18px;">
                        <span style="display:inline-block;border:1px solid rgba(255,255,255,.18);border-radius:999px;padding:7px 10px;font-size:12px;line-height:16px;color:#ccfbf1;font-weight:700;">${escapeHtml(issue.sourceLabel)}</span>
                        <span style="display:inline-block;margin-left:8px;border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:7px 10px;font-size:12px;line-height:16px;color:#cbd5e1;">${escapeHtml(itemCount)}</span>
                      </div>
                      <h1 style="margin:0 0 14px;font-size:34px;line-height:42px;color:#ffffff;font-weight:800;">${title}</h1>
                      <p style="margin:0;font-size:16px;line-height:26px;color:#cbd5e1;">${intro}</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:0;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  ${issue.items.map(renderItem).join("")}
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:4px 2px 0;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-radius:16px;background:#f8fafc;border:1px solid #e2e8f0;">
                  <tr>
                    <td style="padding:18px 20px;">
                      <p style="margin:0;font-size:12px;line-height:19px;color:#64748b;">Generated by Feedletter on ${generated}. You can edit this HTML before sending or use issue.json with your own template.</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function renderText(issue: DigestIssue) {
  const lines = [
    issue.title,
    "",
    issue.intro,
    "",
    ...issue.items.flatMap((item, index) => [
      `${index + 1}. ${item.title}`,
      item.summary ?? "",
      item.url ?? "",
      "",
    ]),
    `Generated by Feedletter on ${formatDate(issue.generatedAt)}.`,
    "",
  ];

  return lines.filter((line, index, all) => line || all[index - 1] !== "").join("\n");
}
