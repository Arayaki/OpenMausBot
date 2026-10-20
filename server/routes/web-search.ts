// The internal call behind the agents web_search tool. It runs inside index.ts's /api/internal/ block after the
// capability bearer is checked, and re-checks the bot's own switch: the tool list shown at the start of a turn is not
// permission to search after the switch went off.
import type { ServerResponse } from "node:http";
import { z } from "zod";
import type { json as sendJson } from "../harness/http.ts";
import {
  searchWeb,
  WEB_SEARCH_MAX_RESULTS,
  WEB_SEARCH_MESSAGES,
  WEB_SEARCH_RECENCY,
  WebSearchError,
  type WebSearchFetch,
} from "../web-search.ts";
import { PASS } from "./table.ts";

export const WEB_SEARCH_ROUTE = "/api/internal/web/search";

export interface WebSearchDeps {
  botEnabled: (botId: string) => boolean;
  fetch?: WebSearchFetch;
}

export interface WebSearchInternalContext {
  method: string;
  path: string;
  res: ServerResponse;
  json: typeof sendJson;
  /** The capability's own bot, never a body field. */
  botId: string;
  readBody: () => Promise<unknown>;
}

const searchBody = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(WEB_SEARCH_MAX_RESULTS).optional(),
  recency: z.enum(WEB_SEARCH_RECENCY).optional(),
  region: z.string().regex(/^[a-z]{2,3}-[a-z]{2,3}$/, "region must be a DuckDuckGo region code such as vn-vi or us-en").optional(),
});

export function createWebSearchInternalRoutes(deps: WebSearchDeps) {
  return async (ctx: WebSearchInternalContext): Promise<typeof PASS | void> => {
    if (ctx.method !== "POST" || ctx.path !== WEB_SEARCH_ROUTE) return PASS;
    if (!deps.botEnabled(ctx.botId)) return void ctx.json(ctx.res, 403, { error: WEB_SEARCH_MESSAGES.botOff });
    const parsed = searchBody.safeParse((await ctx.readBody()) ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return void ctx.json(ctx.res, 400, { error: `${issue?.path.join(".") || "input"}: ${issue?.message ?? "invalid"}` });
    }
    try {
      ctx.json(ctx.res, 200, await searchWeb(parsed.data, deps.fetch ? { fetch: deps.fetch } : {}));
    } catch (error) {
      if (!(error instanceof WebSearchError)) throw error;
      ctx.json(ctx.res, error.code === "blocked" ? 429 : 502, { error: error.message, code: error.code });
    }
  };
}
