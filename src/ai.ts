import type { AiOptions, DigestIssue, DigestPatch, DigestPatchItem, SourceItem } from "./types.js";

export function buildDigestPrompt(issue: DigestIssue, tone: string) {
  const items = issue.items
    .map((item, index) => {
      return [
        `${index + 1}. ${item.title}`,
        item.summary ? `Summary: ${item.summary}` : undefined,
        item.url ? `URL: ${item.url}` : undefined,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

  return `You write concise editorial email digests.

Tone: ${tone}
Return JSON only with these keys:
- subject: max 72 chars, used as the email subject
- preheader: max 120 chars
- intro: 1 short paragraph, no markdown
- items: optional array matching the source item order, each with optional title and summary rewrites

Digest title: ${issue.title}
Existing description: ${issue.intro}
${issue.instructions ? `\nCustom instructions:\n${issue.instructions}\n` : ""}

Items:
${items}`;
}

function safeItems(value: unknown): DigestPatchItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => {
    if (!item || typeof item !== "object") return {};
    const input = item as Record<string, unknown>;
    return {
      title: typeof input.title === "string" ? input.title.trim() : undefined,
      summary: typeof input.summary === "string" ? input.summary.trim() : undefined,
    };
  });
}

function safePatch(value: unknown): DigestPatch {
  if (!value || typeof value !== "object") return {};
  const input = value as Record<string, unknown>;
  return {
    subject: typeof input.subject === "string" ? input.subject.trim() : undefined,
    title: typeof input.title === "string" ? input.title.trim() : undefined,
    preheader: typeof input.preheader === "string" ? input.preheader.trim() : undefined,
    intro: typeof input.intro === "string" ? input.intro.trim() : undefined,
    items: safeItems(input.items),
  };
}

export function applyDigestPatch(issue: DigestIssue, patch: DigestPatch): DigestIssue {
  return {
    ...issue,
    title: patch.subject || patch.title || issue.title,
    preheader: patch.preheader || issue.preheader,
    intro: patch.intro || issue.intro,
    items: issue.items.map((item, index) => {
      const itemPatch = patch.items?.[index];
      if (!itemPatch) return item;
      return {
        ...item,
        title: itemPatch.title || item.title,
        summary: itemPatch.summary || item.summary,
      };
    }),
  };
}

export function buildFallbackIssue(
  title: string,
  description: string | undefined,
  sourceLabel: string,
  items: SourceItem[],
  instructions?: string,
  skippedSeenCount?: number,
): DigestIssue {
  const firstTitle = items[0]?.title;
  return {
    title,
    preheader: firstTitle ? `${firstTitle} and ${Math.max(items.length - 1, 0)} more update${items.length === 2 ? "" : "s"}.` : "Latest updates.",
    intro: description ?? "A quick digest of the latest updates.",
    items,
    generatedAt: new Date().toISOString(),
    sourceLabel,
    instructions,
    skippedSeenCount,
  };
}

export async function enrichIssueWithAi(issue: DigestIssue, options: AiOptions): Promise<DigestIssue> {
  if (!options.enabled) return issue;
  if (!options.apiKey) {
    throw new Error("AI enrichment requires an API key. Set OPENAI_API_KEY or AI_API_KEY.");
  }
  if (!options.model) {
    throw new Error("AI enrichment requires a model. Set AI_MODEL.");
  }

  const response = await fetch(`${options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: options.model,
      temperature: 0.4,
      messages: [
        {
          role: "system",
          content: "You produce JSON for email digest metadata. Do not include prose outside JSON.",
        },
        {
          role: "user",
          content: buildDigestPrompt(issue, options.tone ?? "clear, useful, developer-friendly"),
        },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`AI enrichment failed with ${response.status}: ${body}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) return issue;

  return applyDigestPatch(issue, safePatch(JSON.parse(content)));
}
