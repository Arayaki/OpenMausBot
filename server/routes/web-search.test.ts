import { describe, expect, it, vi } from "vitest";
import { WEB_SEARCH_MESSAGES, type WebSearchFetch } from "../web-search.ts";
import { PASS } from "./table.ts";
import { createWebSearchInternalRoutes, WEB_SEARCH_ROUTE, type WebSearchInternalContext } from "./web-search.ts";

const RESULTS_PAGE = `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example%2F">A</a><a class="result__snippet">About A</a></div>`;

async function callInternal(
  handler: ReturnType<typeof createWebSearchInternalRoutes>,
  { path = WEB_SEARCH_ROUTE, method = "POST", body = { query: "tts" } as unknown, botId = "bot-1" } = {},
) {
  const sent: { status?: number; body?: any } = {};
  const json = ((_res: unknown, status: number, payload: unknown) => {
    sent.status = status;
    sent.body = payload;
  }) as WebSearchInternalContext["json"];
  const res = { setHeader: vi.fn() } as unknown as WebSearchInternalContext["res"];
  const out = await handler({ method, path, res, json, botId, readBody: async () => body });
  return { out, ...sent };
}

function handlerWith(fetchImpl: WebSearchFetch) {
  return createWebSearchInternalRoutes({ botEnabled: (id) => id === "bot-1", fetch: fetchImpl });
}

describe("web search internal route", () => {
  it("passes requests that are not its own", async () => {
    const handler = handlerWith(vi.fn());
    expect((await callInternal(handler, { path: "/api/internal/x/search" })).out).toBe(PASS);
    expect((await callInternal(handler, { method: "GET" })).out).toBe(PASS);
  });

  it("refuses a bot whose switch is off before searching", async () => {
    const fetchImpl = vi.fn<WebSearchFetch>();
    const answer = await callInternal(handlerWith(fetchImpl), { botId: "bot-2" });
    expect(answer).toMatchObject({ status: 403, body: { error: WEB_SEARCH_MESSAGES.botOff } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects bad input with the field that is wrong", async () => {
    const fetchImpl = vi.fn<WebSearchFetch>();
    const handler = handlerWith(fetchImpl);
    expect(await callInternal(handler, { body: { query: "  " } })).toMatchObject({ status: 400 });
    expect(await callInternal(handler, { body: { query: "q", limit: 99 } })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/^limit:/) } });
    expect(await callInternal(handler, { body: { query: "q", region: "Vietnam" } })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/^region:/) } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("answers with the results", async () => {
    const handler = handlerWith(async () => new Response(RESULTS_PAGE, { status: 200 }));
    expect(await callInternal(handler, { body: { query: "tts", limit: 5 } })).toMatchObject({
      status: 200,
      body: { provider: "duckduckgo", query: "tts", results: [{ title: "A", url: "https://a.example/", snippet: "About A" }] },
    });
  });

  it("answers DuckDuckGo's bot check with 429 and a sentence the bot can act on", async () => {
    const handler = handlerWith(async () => new Response("<div class=\"anomaly-modal\"></div>", { status: 202 }));
    expect(await callInternal(handler)).toMatchObject({ status: 429, body: { error: WEB_SEARCH_MESSAGES.blocked, code: "blocked" } });
  });
});
