export interface SourceItem {
  title: string;
  url?: string;
  summary?: string;
  content?: string;
  date?: string;
  author?: string;
  source?: string;
}

export interface DigestIssue {
  title: string;
  preheader: string;
  intro: string;
  items: SourceItem[];
  generatedAt: string;
  sourceLabel: string;
  instructions?: string;
  skippedSeenCount?: number;
}

export interface BuildOptions {
  title: string;
  description?: string;
  limit: number;
  baseUrl?: string;
  sourceLabel?: string;
}

export interface AiOptions {
  enabled: boolean;
  baseUrl: string;
  apiKey?: string;
  model?: string;
  tone?: string;
}

export interface DigestPatchItem {
  title?: string;
  summary?: string;
}

export interface DigestPatch {
  subject?: string;
  title?: string;
  preheader?: string;
  intro?: string;
  items?: DigestPatchItem[];
}
