// The agents catalog's web_search tool: a keyless search shown only to a bot whose web search switch is on.
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

export const WEB_SEARCH_TOOL_NAME = "web_search";

export async function callWebSearchTool(args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const { ok, body } = await context.client.apiResponse("/api/internal/web/search", { method: "POST", body: JSON.stringify(args) });
  return ok ? { text: JSON.stringify(body) } : { text: String(body.error ?? "Web search failed. Try again shortly, or use the browser."), isError: true };
}

export const WEB_SEARCH_TOOL_DEFINITION = {
  name: WEB_SEARCH_TOOL_NAME,
  description:
    "Search the web (DuckDuckGo) and get back titles, links and short snippets, in a few seconds. Use it to find which pages are worth reading before opening any in a browser, and for current information beyond your training. Snippets are previews: open a page before you quote numbers, prices or limits from it. Write focused queries; the query takes \"exact phrase\", -term, OR, site:example.com and filetype:pdf. To read a known address, open it directly instead of searching.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string", minLength: 1, maxLength: 500, description: "The search query." },
      limit: { type: "integer", minimum: 1, maximum: 20, description: "How many results, 1-20. Default 10." },
      recency: { type: "string", enum: ["day", "week", "month", "year"], description: "Only pages from the last day, week, month or year." },
      region: { type: "string", description: "A DuckDuckGo region code such as vn-vi or us-en, for results from that country and language. Omit for worldwide." },
    },
    required: ["query"],
  },
};
