// End-to-end coverage for web_search on a real server and a real agents proxy: which bots are shown the tool, and what
// a call returns. A loopback stub stands in for DuckDuckGo (OMB_DUCKDUCKGO_URL), so no external service is reached.
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";

const RESULTS = `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgroq.com%2Fpricing%2F">Groq <b>Pricing</b></a>
<a class="result__snippet">Whisper large v3 turbo, per hour of audio</a></div>`;

async function serveStub(queries: string[]): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => { raw += chunk; });
    req.on("end", () => {
      queries.push(new URLSearchParams(raw).get("q") ?? "");
      res.writeHead(req.method === "POST" && req.url === "/html/" ? 200 : 404, { "content-type": "text/html" });
      res.end(RESULTS);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no stub port");
  return { server, url: `http://127.0.0.1:${address.port}/html/` };
}

it("shows web_search only to a bot switched on, and its call returns the stub's results", async () => {
  const queries: string[] = [];
  const stub = await serveStub(queries);
  const session = await launchVerificationServer({ ...process.env, OMB_DUCKDUCKGO_URL: stub.url }, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") =>
    request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  const planPath = join(session.info.dataDir, "room-plan.json");
  const turn = async (bot: any, steps: Array<{ tool: string; arguments: unknown }>) => {
    writeFileSync(planPath, JSON.stringify({ [bot.id]: { steps, reply: "Done." } }));
    await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Search this.");
    expect((await cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status).toBe("settled");
    const lines = existsSync(planPath + ".evidence.jsonl") ? readFileSync(planPath + ".evidence.jsonl", "utf8").trim().split("\n").filter(Boolean) : [];
    const evidence = lines.map((line) => JSON.parse(line)).filter((entry: any) => entry.botId === bot.id).at(-1).evidence;
    return {
      tools: evidence[0].result.tools.map((tool: any) => tool.name) as string[],
      results: evidence.filter((entry: any) => entry.step).map((entry: any) => entry.response.result),
    };
  };
  try {
    const off = (await cli("new-bot", "--name", "No search")).bot;
    expect(off.webSearch).toBeUndefined();
    expect((await turn(off, [])).tools).not.toContain("web_search");

    const on = (await cli("new-bot", "--name", "Searcher")).bot;
    await expect(api("/api/bots/" + on.id, { webSearch: "yes" }, "PATCH")).rejects.toThrow(/webSearch must be true or false/);
    expect((await api("/api/bots/" + on.id, { webSearch: true }, "PATCH")).bot.webSearch).toBe(true);
    const { tools, results } = await turn(on, [{ tool: "web_search", arguments: { query: "groq whisper pricing", limit: 3 } }]);
    expect(tools).toContain("web_search");
    expect(results[0].isError).toBeFalsy();
    expect(JSON.parse(results[0].content[0].text)).toEqual({
      provider: "duckduckgo",
      query: "groq whisper pricing",
      results: [{ title: "Groq Pricing", url: "https://groq.com/pricing/", snippet: "Whisper large v3 turbo, per hour of audio" }],
    });
    expect(queries).toEqual(["groq whisper pricing"]);
  } finally {
    stub.server.close();
    await session.close();
  }
}, 120_000);
