import { describe, expect, it, vi } from "vitest";
import {
  decodeHtmlText,
  parseDuckDuckGoResults,
  parseNextPageForm,
  searchWeb,
  unwrapResultUrl,
  WEB_SEARCH_MESSAGES,
  WebSearchError,
  type WebSearchFetch,
} from "./web-search.ts";

function row(target: string, title: string, snippet?: string, date?: string): string {
  const href = `//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&amp;rut=abc`;
  return `<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="${href}">${title}</a></h2>
    <div class="result__extras"><div class="result__extras__url"><a class="result__url" href="${href}">${target}</a>${date ? `<span>&nbsp; &nbsp; ${date}</span>` : ""}</div></div>
    ${snippet === undefined ? "" : `<a class="result__snippet" href="${href}">${snippet}</a>`}
  </div>
</div>`;
}

function page(rows: string[], next?: { s: string }): string {
  const nextForm = next
    ? `<div class="nav-link"><form action="/html/" method="post"><input type="submit" class="btn" value="Next" /><input type="hidden" name="q" value="tts" /><input type="hidden" name="s" value="${next.s}" /><input type="hidden" name="vqd" value="4-123" /></form></div>`
    : "";
  return `<html><body><div class="serp__results">${rows.join("\n")}${nextForm}</div></body></html>`;
}

function fakeFetch(pages: Array<{ status?: number; body: string }>) {
  const calls: Array<{ url: string; body: string }> = [];
  const impl = vi.fn<WebSearchFetch>(async (url, init) => {
    calls.push({ url, body: String(init.body) });
    const next = pages[calls.length - 1] ?? { body: page([]) };
    return new Response(next.body, { status: next.status ?? 200 });
  });
  return { impl, calls };
}

describe("DuckDuckGo result parsing", () => {
  it("reads title, unwrapped target, snippet and date from each row", () => {
    const html = page([
      row("https://ai.zalo.solutions/docs/api/text-to-audio-converter", "Text to Audio - <b>Zalo</b> AI", "Fast <b>Vietnamese</b> TTS &amp; more", "2026-07-30T20:19:00.0000000"),
      row("https://github.com/dangvansam/viet-tts", "VietTTS"),
    ]);
    expect(parseDuckDuckGoResults(html)).toEqual([
      { title: "Text to Audio - Zalo AI", url: "https://ai.zalo.solutions/docs/api/text-to-audio-converter", snippet: "Fast Vietnamese TTS & more", published: "2026-07-30" },
      { title: "VietTTS", url: "https://github.com/dangvansam/viet-tts" },
    ]);
  });

  it("drops ad redirects and links that are not web addresses", () => {
    expect(unwrapResultUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js%3Fad%3D1")).toBeUndefined();
    expect(unwrapResultUrl("//duckduckgo.com/l/?uddg=javascript%3Aalert(1)")).toBeUndefined();
    expect(unwrapResultUrl("//duckduckgo.com/l/?uddg=%E0%A4%A")).toBeUndefined();
    expect(unwrapResultUrl("//example.com/page")).toBe("https://example.com/page");
    expect(unwrapResultUrl("https://example.com/a?b=1&amp;c=2")).toBe("https://example.com/a?b=1&c=2");
  });

  it("decodes each entity once, so escaped markup stays text", () => {
    expect(decodeHtmlText("a &amp;lt;b&amp;gt; &#39;c&#39; &#x1F600;")).toBe("a &lt;b&gt; 'c' 😀");
  });

  it("finds the next-page form whatever the attribute order", () => {
    const form = parseNextPageForm(page([], { s: "10" }));
    expect(form?.get("s")).toBe("10");
    expect(form?.get("vqd")).toBe("4-123");
    expect(parseNextPageForm(page([]))).toBeUndefined();
  });
});

describe("searchWeb", () => {
  it("posts the query with the recency and region filters", async () => {
    const { impl, calls } = fakeFetch([{ body: page([row("https://a.example/", "A")]) }]);
    const answer = await searchWeb({ query: "free tts api", recency: "month", region: "vn-vi" }, { fetch: impl });
    expect(answer).toEqual({ provider: "duckduckgo", query: "free tts api", results: [{ title: "A", url: "https://a.example/" }] });
    expect(calls[0]!.url).toBe("https://html.duckduckgo.com/html/");
    const sent = new URLSearchParams(calls[0]!.body);
    expect([sent.get("q"), sent.get("df"), sent.get("kl")]).toEqual(["free tts api", "m", "vn-vi"]);
  });

  it("follows the next page until the limit, without repeating a link", async () => {
    const first = page([row("https://a.example/", "A"), row("https://b.example/", "B")], { s: "2" });
    const second = page([row("https://b.example/", "B"), row("https://c.example/", "C"), row("https://d.example/", "D")]);
    const { impl, calls } = fakeFetch([{ body: first }, { body: second }]);
    const answer = await searchWeb({ query: "q", limit: 3 }, { fetch: impl });
    expect(answer.results.map((result) => result.url)).toEqual(["https://a.example/", "https://b.example/", "https://c.example/"]);
    expect(new URLSearchParams(calls[1]!.body).get("s")).toBe("2");
  });

  it("stops at one page when that page fills the limit", async () => {
    const { impl } = fakeFetch([{ body: page([row("https://a.example/", "A"), row("https://b.example/", "B")], { s: "2" }) }]);
    await searchWeb({ query: "q", limit: 2 }, { fetch: impl });
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("names DuckDuckGo's bot check, whatever status it came with", async () => {
    for (const reply of [{ status: 202, body: "<div class=\"anomaly-modal\"></div>" }, { status: 429, body: "" }]) {
      const { impl } = fakeFetch([reply]);
      const failure = await searchWeb({ query: "q" }, { fetch: impl }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(WebSearchError);
      expect(failure).toMatchObject({ code: "blocked", message: WEB_SEARCH_MESSAGES.blocked });
    }
  });

  it("turns a network failure and a server error into unavailable", async () => {
    const offline = vi.fn<WebSearchFetch>(async () => { throw new TypeError("fetch failed"); });
    await expect(searchWeb({ query: "q" }, { fetch: offline })).rejects.toMatchObject({ code: "unavailable" });
    const { impl } = fakeFetch([{ status: 500, body: "oops" }]);
    await expect(searchWeb({ query: "q" }, { fetch: impl })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("stops a search that runs past its time limit", async () => {
    const hanging = vi.fn<WebSearchFetch>((_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    await expect(searchWeb({ query: "q" }, { fetch: hanging, timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });
  });
});
