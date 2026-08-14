import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { AuthHandler, type Props } from "./auth-handler";

// Shared helper: every crawl4ai REST call needs the same auth header, the
// same "is this actually a success" check, and the same error shape back to
// the model. One place to get that right instead of five.
async function callEngine(
  env: Env,
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; data: any } | { ok: false; message: string }> {
  let response: Response;
  try {
    response = await fetch(`${env.CRAWL4AI_ENGINE_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.CRAWL4AI_API_TOKEN}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err: any) {
    return { ok: false, message: `Could not reach the engine: ${err.message}` };
  }

  // Request-level failures (bad params, SSRF-blocked, 404 route, etc.) —
  // FastAPI's {"detail": "..."} shape, confirmed against the real engine
  // back at step 3-4.
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message =
      (body as { detail?: string } | null)?.detail ??
      `Engine returned HTTP ${response.status}`;
    return { ok: false, message };
  }

  const data = await response.json().catch(() => null);
  if (data === null) {
    return { ok: false, message: "Engine returned a non-JSON response" };
  }

  // Crawl-level failures (timeout, unreachable target, etc.) — 200 status
  // but success:false in the body, per crawl4ai's documented CrawlResult
  // shape, same as fetch_page confirmed earlier.
  if (typeof data.success === "boolean" && !data.success) {
    return {
      ok: false,
      message: data.error_message ?? "Engine reported failure with no message",
    };
  }

  return { ok: true, data };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: `Failed: ${message}` }],
    isError: true,
  };
}

async function callSearxng(
  env: Env,
  path: string,
  params: Record<string, string>,
): Promise<{ ok: true; data: any } | { ok: false; message: string }> {
  const url = new URL(`${env.SEARXNG_URL}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  let response: Response;
  try {
    response = await fetch(url.toString());
  } catch (err: any) {
    return {
      ok: false,
      message: `Could not reach the search engine: ${err.message}`,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      message: `Search engine returned HTTP ${response.status}`,
    };
  }
  const data = await response.json().catch(() => null);
  if (data === null) {
    return { ok: false, message: "Search engine returned a non-JSON response" };
  }
  return { ok: true, data };
}

export class MyMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({
    name: "search-mcp",
    version: "1.0.0",
  });

  async init() {
    this.server.tool(
      "fetch_page",
      "Fetch a webpage, including JavaScript-rendered content, and return its content as clean markdown with navigation, ads, and boilerplate stripped out.",
      {
        url: z
          .string()
          .url()
          .describe("Full URL of the page to fetch, including https://"),
        f: z
          .enum(["fit", "raw", "bm25", "llm"])
          .default("fit")
          .describe(
            "Extraction mode: fit (clean readable content, default), raw (direct HTML-to-markdown), bm25 (keyword relevance ranking), llm (summarization)",
          ),
        q: z
          .string()
          .optional()
          .describe("Query string, used by bm25/llm modes to focus extraction"),
      },
      async ({ url, f, q }) => {
        const result = await callEngine(this.env, "/md", { url, f, q });
        if (!result.ok) return errorResult(result.message);
        return {
          content: [{ type: "text", text: result.data.markdown ?? "" }],
        };
      },
    );

    this.server.tool(
      "fetch_html",
      "Fetch a webpage, including JavaScript-rendered content, and return sanitized, preprocessed HTML — use when you need structured markup rather than markdown, e.g. for building extraction schemas.",
      { url: z.string().url().describe("Full URL of the page to fetch") },
      async ({ url }) => {
        const result = await callEngine(this.env, "/html", { url });
        if (!result.ok) return errorResult(result.message);
        // Exact response field isn't confirmed from the tool schema alone
        // (that only showed the input shape) — fall back to the raw body
        // if the expected field isn't there, rather than silently
        // returning nothing.
        const text = result.data.html ?? JSON.stringify(result.data);
        return { content: [{ type: "text", text }] };
      },
    );

    this.server.tool(
      "screenshot_page",
      "Capture a full-page PNG screenshot of a webpage.",
      {
        url: z.string().url().describe("Full URL of the page to capture"),
        screenshot_wait_for: z
          .number()
          .default(2)
          .describe("Seconds to wait before capturing"),
      },
      async ({ url, screenshot_wait_for }) => {
        const result = await callEngine(this.env, "/screenshot", {
          url,
          screenshot_wait_for,
        });
        if (!result.ok) return errorResult(result.message);

        // The initial response only hands back an artifact reference, not
        // the image itself — a second authenticated fetch is needed to
        // actually retrieve the bytes.
        const artifactUrl = result.data.url;
        if (!artifactUrl) {
          return errorResult(
            "Engine didn't return an artifact URL for the screenshot",
          );
        }
        const imageResponse = await fetch(
          new URL(artifactUrl, this.env.CRAWL4AI_ENGINE_URL).toString(),
          {
            headers: { Authorization: `Bearer ${this.env.CRAWL4AI_API_TOKEN}` },
          },
        );

        if (!imageResponse.ok) {
          return errorResult(
            `Could not retrieve the screenshot artifact (HTTP ${imageResponse.status})`,
          );
        }
        const bytes = await imageResponse.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(bytes)));
        return {
          content: [{ type: "image", data: base64, mimeType: "image/png" }],
        };
      },
    );

    this.server.tool(
      "execute_js",
      "Load a webpage and run one or more JavaScript snippets against it, returning the result. Use for interacting with a page (clicking, scrolling, reading dynamic state) beyond plain content extraction.",
      {
        url: z.string().url().describe("Full URL of the page to load first"),
        scripts: z
          .array(z.string())
          .describe("JavaScript snippets to execute, in order"),
      },
      async ({ url, scripts }) => {
        // Endpoint name inferred from crawl4ai's documented REST API, not
        // directly confirmed from the (truncated) tool schema — first
        // real call here doubles as the confirmation.
        const result = await callEngine(this.env, "/execute_js", {
          url,
          scripts,
        });
        if (!result.ok) return errorResult(result.message);
        return {
          content: [
            { type: "text", text: JSON.stringify(result.data, null, 2) },
          ],
        };
      },
    );

    this.server.tool(
      "crawl_urls",
      "Crawl a list of URLs (up to 100) and return results for each as JSON, including JavaScript-rendered content. Use for fetching multiple pages in one call rather than one at a time.",
      {
        urls: z
          .array(z.string().url())
          .min(1)
          .max(100)
          .describe("URLs to crawl"),
        output: z
          .array(
            z.enum([
              "markdown",
              "html",
              "links",
              "media",
              "metadata",
              "tables",
            ]),
          )
          .default(["markdown"])
          .describe(
            "Which data to include per URL. markdown: clean readable text (default). html: cleaned/sanitized HTML. links: internal/external links found on the page. media: images/videos/audios found. metadata: title/description/keywords/author. tables: extracted HTML tables as structured data.",
          ),
      },
      async ({ urls, output }) => {
        const result = await callEngine(this.env, "/crawl", { urls });
        if (!result.ok) return errorResult(result.message);

        const trimmed = (result.data.results ?? []).map((r: any) => {
          const entry: Record<string, unknown> = {
            url: r.url,
            success: r.success,
          };
          if (!r.success) {
            entry.error = r.error_message;
            return entry;
          }
          if (output.includes("markdown"))
            entry.markdown =
              r.markdown?.fit_markdown || r.markdown?.raw_markdown || "";
          if (output.includes("html")) entry.html = r.cleaned_html;
          if (output.includes("links")) entry.links = r.links;
          if (output.includes("media")) entry.media = r.media;
          if (output.includes("metadata")) entry.metadata = r.metadata;
          if (output.includes("tables")) entry.tables = r.tables;
          return entry;
        });
        return {
          content: [{ type: "text", text: JSON.stringify(trimmed, null, 2) }],
        };
      },
    );

    this.server.tool(
      "web_search",
      "Search the web for a query and return a ranked list of results (title, URL, and a short snippet each). Use this to find relevant pages before fetching one in full with fetch_page.",
      {
        query: z.string().describe("The search query"),
        time_range: z
          .enum(["day", "week", "month", "year"])
          .optional()
          .describe("Restrict results to this recency window"),
        language: z
          .string()
          .optional()
          .describe(
            "Language code for results, e.g. 'en'. Omit for all languages.",
          ),
      },
      async ({ query, time_range, language }) => {
        const params: Record<string, string> = { q: query, format: "json" };
        if (time_range) params.time_range = time_range;
        if (language) params.language = language;

        const result = await callSearxng(this.env, "/search", params);
        if (!result.ok) return errorResult(result.message);

        const results = (result.data.results ?? [])
          .slice(0, 10)
          .map((r: any) => ({
            title: r.title,
            url: r.url,
            snippet: r.content,
          }));
        if (results.length === 0)
          return errorResult("No results found for this query");
        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
        };
      },
    );

    this.server.tool(
      "image_search",
      "Search the web for images matching a query. Returns title, source page URL, and the direct image URL for each result.",
      { query: z.string().describe("The search query") },
      async ({ query }) => {
        const result = await callSearxng(this.env, "/search", {
          q: query,
          format: "json",
          categories: "images",
        });
        if (!result.ok) return errorResult(result.message);

        const results = (result.data.results ?? [])
          .slice(0, 10)
          .map((r: any) => ({
            title: r.title,
            source_url: r.url,
            image_url: r.img_src,
            thumbnail_url: r.thumbnail_src ?? r.thumbnail,
          }));
        if (results.length === 0)
          return errorResult("No image results found for this query");
        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
        };
      },
    );

    this.server.tool(
      "news_search",
      "Search for recent news articles matching a query. Returns title, URL, snippet, and publish date where available.",
      {
        query: z.string().describe("The search query"),
        time_range: z
          .enum(["day", "week", "month", "year"])
          .optional()
          .describe("Restrict results to this recency window"),
      },
      async ({ query, time_range }) => {
        const params: Record<string, string> = {
          q: query,
          format: "json",
          categories: "news",
        };
        if (time_range) params.time_range = time_range;

        const result = await callSearxng(this.env, "/search", params);
        if (!result.ok) return errorResult(result.message);

        const results = (result.data.results ?? [])
          .slice(0, 10)
          .map((r: any) => ({
            title: r.title,
            url: r.url,
            snippet: r.content,
            published: r.publishedDate,
          }));
        if (results.length === 0)
          return errorResult("No news results found for this query");
        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
        };
      },
    );

    this.server.tool(
      "search_suggestions",
      "Get autocomplete query suggestions for a partial search term — useful for query refinement before a full search.",
      { query: z.string().describe("Partial search term") },
      async ({ query }) => {
        // Response shape not yet confirmed empirically — SearXNG's autocompleter
        // commonly returns either a flat array of strings, or an OpenSearch-style
        // [query, [suggestions]] pair. Handling both; first real call is the
        // actual confirmation.
        const result = await callSearxng(this.env, "/autocompleter", {
          q: query,
        });
        if (!result.ok) return errorResult(result.message);

        const suggestions = Array.isArray(result.data[0])
          ? result.data[0]
          : Array.isArray(result.data)
            ? result.data
            : (result.data[1] ?? result.data);
        return {
          content: [{ type: "text", text: JSON.stringify(suggestions) }],
        };
      },
    );

    this.server.tool(
      "search_instance_info",
      "Discover the search categories, engines, and plugins available on this SearXNG instance.",
      {},
      async () => {
        const result = await callSearxng(this.env, "/config", {});
        if (!result.ok) return errorResult(result.message);
        return {
          content: [
            { type: "text", text: JSON.stringify(result.data, null, 2) },
          ],
        };
      },
    );
  }
}

export default new OAuthProvider({
  apiHandler: MyMCP.serve("/mcp"),
  apiRoute: "/mcp",
  authorizeEndpoint: "/authorize",
  clientRegistrationEndpoint: "/register",
  defaultHandler: AuthHandler as any,
  tokenEndpoint: "/token",
});
