import { z } from "zod";

export const fieldSchema = z.object({
  name: z.string().trim().min(1).max(40),
  selector: z.string().trim().min(1).max(300),
  attr: z.string().trim().max(40).optional(),
  multiple: z.boolean().optional(),
});

export const configSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  mode: z.enum(["single", "crawl"]).default("single"),
  render: z.enum(["auto", "static", "browser"]).default("auto"),
  maxDepth: z.number().int().min(0).max(5).default(1),
  maxPages: z.number().int().min(1).max(100).default(15),
  concurrency: z.number().int().min(1).max(5).default(3),
  delayMs: z.number().int().min(0).max(5000).default(250),
  timeoutMs: z.number().int().min(2000).max(60000).default(15000),
  respectRobots: z.boolean().default(true),
  sameDomainOnly: z.boolean().default(true),
  useSitemap: z.boolean().default(false),
  includePattern: z.string().max(200).optional(),
  excludePattern: z.string().max(200).optional(),
  userAgent: z.enum(["arachne", "chrome", "googlebot", "mobile"]).default("arachne"),
  fields: z.array(fieldSchema).max(20).default([]),
  aiPrompt: z.string().max(1000).optional(),
});

export type ScrapeConfig = z.infer<typeof configSchema>;
export type FieldSpec = z.infer<typeof fieldSchema>;

export type Stage = "resolve" | "robots" | "fetch" | "render" | "parse" | "extract" | "ai";

export const STAGES: { id: Stage; label: string }[] = [
  { id: "resolve", label: "Resolve" },
  { id: "robots", label: "Robots" },
  { id: "fetch", label: "Fetch" },
  { id: "render", label: "Render" },
  { id: "parse", label: "Parse" },
  { id: "extract", label: "Extract" },
  { id: "ai", label: "AI" },
];

export interface LinkInfo {
  href: string;
  text: string;
  internal: boolean;
}
export interface ImageInfo {
  src: string;
  alt: string;
}

export interface PageResult {
  url: string;
  finalUrl: string;
  status: number;
  depth: number;
  renderedWith: "static" | "browser";
  fetchMs: number;
  bytes: number;
  title: string;
  description: string;
  lang: string;
  canonical: string;
  ogImage: string;
  headings: { level: number; text: string }[];
  links: LinkInfo[];
  images: ImageInfo[];
  tables: string[][][];
  emails: string[];
  phones: string[];
  jsonLd: unknown[];
  text: string;
  markdown: string;
  wordCount: number;
  readingMins: number;
  fields: Record<string, string | string[] | null>;
  ai?: unknown;
  aiError?: string;
  error?: string;
}

export type LogLevel = "info" | "ok" | "warn" | "error" | "debug";

export type ScrapeEvent =
  | { type: "start"; runId: string; url: string; ts: number }
  | { type: "stage"; stage: Stage; pageUrl: string; status: "active" | "done" | "skipped" | "error"; ts: number }
  | { type: "log"; level: LogLevel; message: string; ts: number }
  | { type: "discover"; from: string; to: string; depth: number }
  | { type: "page"; page: PageResult }
  | {
      type: "progress";
      crawled: number;
      queued: number;
      discovered: number;
      errors: number;
      bytes: number;
      total: number;
    }
  | { type: "done"; pages: number; errors: number; bytes: number; ms: number; stopped: boolean }
  | { type: "error"; message: string };

export type RunStatus = "idle" | "running" | "done" | "error" | "stopped";

