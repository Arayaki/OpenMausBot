// Keyless web search for the agents web_search tool, through DuckDuckGo's no-JavaScript HTML frontend.
//
// The request shape, result parsing and redirect unwrapping are ported from oh-my-pi's DuckDuckGo provider
// (packages/coding-agent/src/web/search/providers/duckduckgo.ts), Copyright (c) 2025 Mario Zechner and
// Copyright (c) 2025-2026 Can Bölük, used under the MIT License (third_party/oh-my-pi/LICENSE).

export const WEB_SEARCH_DEFAULT_RESULTS = 10;
export const WEB_SEARCH_MAX_RESULTS = 20;
export const WEB_SEARCH_TIMEOUT_MS = 20_000;
const MAX_PAGES = 2;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const SNIPPET_LIMIT = 400;

const DUCKDUCKGO_HTML_URL = "https://html.duckduckgo.com/html/";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** OMB_DUCKDUCKGO_URL replaces DuckDuckGo with an https mirror or, in tests, a loopback stand-in; anything else is ignored. */
export function duckDuckGoUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OMB_DUCKDUCKGO_URL?.trim();
  if (!configured) return DUCKDUCKGO_HTML_URL;
  try {
    const parsed = new URL(configured);
    return parsed.protocol === "https:" || (parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname)) ? configured : DUCKDUCKGO_HTML_URL;
  } catch {
    return DUCKDUCKGO_HTML_URL;
  }
}
/** DuckDuckGo answers a client without a browser's headers with its bot challenge. */
const BROWSER_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Content-Type": "application/x-www-form-urlencoded",
  Origin: "https://html.duckduckgo.com",
  Referer: "https://html.duckduckgo.com/",
};

export const WEB_SEARCH_RECENCY = ["day", "week", "month", "year"] as const;
export type WebSearchRecency = (typeof WEB_SEARCH_RECENCY)[number];
const DUCKDUCKGO_DATE_FILTER: Readonly<Record<WebSearchRecency, string>> = { day: "d", week: "w", month: "m", year: "y" };

export interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
  /** As DuckDuckGo prints it on the row, when it prints one. */
  published?: string;
}

export interface WebSearchRequest {
  query: string;
  limit?: number;
  recency?: WebSearchRecency;
  /** A DuckDuckGo region code such as vn-vi or us-en; DuckDuckGo picks one when absent. */
  region?: string;
}

export type WebSearchErrorCode = "blocked" | "unavailable" | "timeout";

export class WebSearchError extends Error {
  readonly code: WebSearchErrorCode;
  constructor(code: WebSearchErrorCode, message: string) {
    super(message);
    this.name = "WebSearchError";
    this.code = code;
  }
}

export const WEB_SEARCH_MESSAGES = {
  botOff: "Web search is off for this bot. Turn it on in this bot's settings under Access.",
  blocked: "DuckDuckGo refused this search with its bot check (it throttles automated searches). Wait a minute before searching again, or open a search page in the browser instead.",
  unavailable: "Web search is temporarily unavailable. Try again shortly, or use the browser.",
  timeout: "Web search took too long and was stopped. Try a shorter query, or use the browser.",
} as const;

export type WebSearchFetch = (url: string, init: RequestInit) => Promise<Response>;

export function decodeHtmlText(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Result links go through DuckDuckGo's click tracker (//duckduckgo.com/l/?uddg=<target>); a bot needs the target. */
export function unwrapResultUrl(href: string): string | undefined {
  const decoded = href.replace(/&amp;/gi, "&");
  const wrapped = /[?&]uddg=([^&]+)/.exec(decoded);
  let target = decoded;
  if (wrapped) {
    try {
      target = decodeURIComponent(wrapped[1]!);
    } catch {
      return undefined;
    }
  } else if (decoded.startsWith("//")) {
    target = `https:${decoded}`;
  }
  return /^https?:\/\//i.test(target) && !isAdRedirect(target) ? target : undefined;
}

function isAdRedirect(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.endsWith("duckduckgo.com") && parsed.pathname.startsWith("/y.js");
  } catch {
    return true;
  }
}

function publishedDate(block: string): string | undefined {
  const extras = /<div\b[^>]*\bclass="[^"]*\bresult__extras__url\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1];
  if (!extras) return undefined;
  for (const match of extras.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)) {
    const text = decodeHtmlText(match[1]!);
    if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}|$)/.test(text)) return text.slice(0, 10);
  }
  return undefined;
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

export function parseDuckDuckGoResults(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const blockRe =
    /<div\b[^>]*\bclass="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)(?=<div\b[^>]*\bclass="[^"]*\bresult\b|<div\b[^>]*\bclass="[^"]*\bnav-link\b|$)/g;
  const titleRe = /<a\b[^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/;
  const snippetRe = /<(?:a|div|span)\b[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/;
  for (const match of html.matchAll(blockRe)) {
    const block = match[1]!;
    const title = titleRe.exec(block);
    if (!title) continue;
    const url = unwrapResultUrl(title[1]!);
    const titleText = decodeHtmlText(title[2]!);
    if (!url || !titleText) continue;
    const snippetMatch = snippetRe.exec(block);
    const snippet = snippetMatch ? clip(decodeHtmlText(snippetMatch[1]!), SNIPPET_LIMIT) : "";
    const published = publishedDate(block);
    results.push({ title: titleText, url, ...(snippet ? { snippet } : {}), ...(published ? { published } : {}) });
  }
  return results;
}

/** The hidden fields of the "Next" form, read input by input because their attribute order varies. */
export function parseNextPageForm(html: string): URLSearchParams | undefined {
  for (const formMatch of html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)) {
    const form = new URLSearchParams();
    for (const inputMatch of formMatch[1]!.matchAll(/<input\b[^>]*>/gi)) {
      const input = inputMatch[0];
      const name = /\bname\s*=\s*(["'])(.*?)\1/i.exec(input)?.[2];
      const value = /\bvalue\s*=\s*(["'])(.*?)\1/i.exec(input)?.[2];
      if (name && value !== undefined) form.append(decodeHtmlText(name), decodeHtmlText(value));
    }
    if (form.has("s") && form.has("vqd")) return form;
  }
  return undefined;
}

/** DuckDuckGo serves its bot challenge with 200 or 202; only the body tells it apart. */
function isBotChallenge(html: string): boolean {
  return html.includes("anomaly-modal") || html.includes("anomaly.js");
}

function firstForm(request: WebSearchRequest): URLSearchParams {
  const form = new URLSearchParams({ q: request.query, b: "" });
  if (request.region) form.set("kl", request.region);
  if (request.recency) form.set("df", DUCKDUCKGO_DATE_FILTER[request.recency]);
  return form;
}

async function readCapped(response: Response): Promise<string> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) throw new WebSearchError("unavailable", WEB_SEARCH_MESSAGES.unavailable);
  const text = await response.text();
  return text.length > MAX_BODY_BYTES ? text.slice(0, MAX_BODY_BYTES) : text;
}

async function fetchPage(fetchImpl: WebSearchFetch, url: string, form: URLSearchParams, signal: AbortSignal): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "POST", body: form.toString(), headers: BROWSER_HEADERS, signal, redirect: "follow" });
  } catch (error) {
    if (signal.aborted) throw new WebSearchError("timeout", WEB_SEARCH_MESSAGES.timeout);
    throw new WebSearchError("unavailable", `${WEB_SEARCH_MESSAGES.unavailable} (${error instanceof Error ? error.message : String(error)})`);
  }
  const html = await readCapped(response);
  if (response.status === 429 || response.status === 403 || isBotChallenge(html)) throw new WebSearchError("blocked", WEB_SEARCH_MESSAGES.blocked);
  if (response.status < 200 || response.status >= 300) {
    throw new WebSearchError("unavailable", `${WEB_SEARCH_MESSAGES.unavailable} (DuckDuckGo answered ${response.status})`);
  }
  return html;
}

export async function searchWeb(
  request: WebSearchRequest,
  options: { fetch?: WebSearchFetch; timeoutMs?: number; url?: string } = {},
): Promise<{ provider: "duckduckgo"; query: string; results: WebSearchResult[] }> {
  const limit = Math.min(Math.max(request.limit ?? WEB_SEARCH_DEFAULT_RESULTS, 1), WEB_SEARCH_MAX_RESULTS);
  const fetchImpl = options.fetch ?? fetch;
  const url = options.url ?? duckDuckGoUrl();
  const signal = AbortSignal.timeout(options.timeoutMs ?? WEB_SEARCH_TIMEOUT_MS);
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  let form: URLSearchParams | undefined = firstForm(request);
  for (let page = 0; form && page < MAX_PAGES && results.length < limit; page += 1) {
    const html = await fetchPage(fetchImpl, url, form, signal);
    const before = results.length;
    for (const result of parseDuckDuckGoResults(html)) {
      if (seen.has(result.url)) continue;
      seen.add(result.url);
      results.push(result);
      if (results.length >= limit) break;
    }
    if (results.length === before) break;
    form = parseNextPageForm(html);
  }
  return { provider: "duckduckgo", query: request.query, results };
}
