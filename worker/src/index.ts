import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { AuthHandler, type Props } from "./auth-handler";

function safeHandler<A extends unknown[]>(
  handler: (...args: A) => Promise<any>,
): (...args: A) => Promise<any> {
  return async (...args: A) => {
    try {
      return await handler(...args);
    } catch (err: any) {
      return errorResult(`Unexpected error: ${err?.message ?? String(err)}`);
    }
  };
}

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
      // 90s, not the hook system's 60s max — a legitimate delay_before_return
      // near 60s must finish before this fires, or it'd falsely abort a
      // valid wait rather than catch a genuinely hung request.
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err: any) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return {
        ok: false,
        message:
          "Engine did not respond within 90s — likely a wait_for selector that never matched, or the target site hanging.",
      };
    }
    return { ok: false, message: `Could not reach the engine: ${err.message}` };
  }

  // Request-level failures (bad params, SSRF-blocked, 404 route, etc.) —
  // FastAPI's {"detail": "..."} shape, confirmed against the real engine
  // back at step 3-4.
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    let message = `Engine returned HTTP ${response.status}`;
    const rawDetail = (errorBody as { detail?: string } | null)?.detail;
    if (rawDetail) {
      try {
        const parsed = JSON.parse(rawDetail);
        message = parsed.correlation_id
          ? `${parsed.error ?? "Engine error"} (correlation_id: ${parsed.correlation_id})`
          : (parsed.error ?? rawDetail);
      } catch {
        message = rawDetail;
      }
    } else if (errorBody && typeof (errorBody as any).error === "string") {
      const eb = errorBody as { error: string; correlation_id?: string };
      message = eb.correlation_id
        ? `${eb.error} (correlation_id: ${eb.correlation_id})`
        : eb.error;
    }
    return { ok: false, message };
  }

  const data = await response.json().catch(() => null);
  if (data === null) {
    return { ok: false, message: "Engine returned a non-JSON response" };
  }

  if (
    typeof data.error === "string" &&
    !("results" in data) &&
    !("markdown" in data)
  ) {
    const message = data.correlation_id
      ? `${data.error} (correlation_id: ${data.correlation_id})`
      : data.error;
    return { ok: false, message };
  }

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
    response = await fetch(url.toString(), {
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err: any) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return {
        ok: false,
        message: "Search engine did not respond within 15s.",
      };
    }
    return {
      ok: false,
      message: `Could not reach the search engine: ${err.message}`,
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
    version: "1.1.0",
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
          .enum(["fit", "raw", "bm25"])
          .default("fit")
          .describe(
            "Extraction mode: fit (clean readable content, default — strips nav/ads/boilerplate), raw (direct HTML-to-markdown, no filtering), bm25 (rank content blocks by relevance to q and keep only the top matches — requires q).",
          ),
        q: z
          .string()
          .optional()
          .describe(
            "Search query. Required when f='bm25' (used to rank content blocks by relevance); ignored for fit/raw.",
          ),
        delay_before_return: z
          .number()
          .optional()
          .describe(
            "Seconds to wait after page load before extracting content (e.g. 2.5). Omit or set to 0 for fastest response.",
          ),
        wait_for: z
          .string()
          .optional()
          .describe(
            "CSS selector to wait for before extracting (e.g. '#content'). Omit or leave empty for fastest response.",
          ),
      },
      safeHandler(async ({ url, f, q, delay_before_return, wait_for }) => {
        if (/\.pdf(\?|#|$)/i.test(url)) {
          return errorResult(
            "This URL appears to be a PDF, which this tool can't parse.",
          );
        }
        if (f === "bm25" && (!q || q.trim().length === 0)) {
          return errorResult(
            "f='bm25' requires a non-empty q — it's the query content blocks are ranked against.",
          );
        }

        const hasDelay =
          typeof delay_before_return === "number" && delay_before_return > 0;
        const hasWaitFor =
          typeof wait_for === "string" && wait_for.trim().length > 0;

        // Route through /crawl ONLY when a non-zero delay or non-empty selector is requested
        if (hasDelay || hasWaitFor) {
          const payload: Record<string, unknown> = { urls: [url] };

          const markdown_generator =
            f === "raw"
              ? { type: "DefaultMarkdownGenerator", params: {} }
              : f === "bm25"
                ? {
                    type: "DefaultMarkdownGenerator",
                    params: {
                      content_filter: {
                        type: "BM25ContentFilter",
                        params: { user_query: q },
                      },
                    },
                  }
                : {
                    // fit (default)
                    type: "DefaultMarkdownGenerator",
                    params: {
                      content_filter: {
                        type: "PruningContentFilter",
                        params: {},
                      },
                    },
                  };

          const crawler_config: Record<string, unknown> = {
            markdown_generator,
          };

          if (hasWaitFor) {
            const selector = wait_for!.trim();
            crawler_config.wait_for =
              selector.startsWith("css:") || selector.startsWith("js:")
                ? selector
                : `css:${selector}`;
          }

          payload.crawler_config = crawler_config;

          if (hasDelay) {
            const delayMs = Math.round(delay_before_return! * 1000);
            payload.hooks = {
              hooks: [
                { action: "wait_for_timeout", params: { timeout_ms: delayMs } },
              ],
            };
          }

          const result = await callEngine(this.env, "/crawl", payload);
          if (!result.ok) return errorResult(result.message);

          const pageResult = result.data.results?.[0];
          if (!pageResult || !pageResult.success) {
            return errorResult(
              pageResult?.error_message ?? "Failed to crawl page",
            );
          }

          const markdown =
            f === "raw"
              ? pageResult.markdown?.raw_markdown ||
                (typeof pageResult.markdown === "string"
                  ? pageResult.markdown
                  : "")
              : pageResult.markdown?.fit_markdown ||
                pageResult.markdown?.raw_markdown ||
                (typeof pageResult.markdown === "string"
                  ? pageResult.markdown
                  : "");

          if (!markdown) {
            return errorResult(
              "Engine returned no markdown content for this page",
            );
          }

          return { content: [{ type: "text", text: markdown }] };
        }

        // Default fast route via /md
        const result = await callEngine(this.env, "/md", { url, f, q });
        if (!result.ok) return errorResult(result.message);
        return {
          content: [{ type: "text", text: result.data.markdown ?? "" }],
        };
      }),
    );

    this.server.tool(
      "fetch_html",
      "Fetch a webpage, including JavaScript-rendered content, and return sanitized, preprocessed HTML — use when you need structured markup rather than markdown, e.g. for building extraction schemas.",
      {
        url: z.string().url().describe("Full URL of the page to fetch"),
        delay_before_return: z
          .number()
          .optional()
          .describe(
            "Seconds to wait after page load before extracting HTML (e.g. 2.5). Omit or set to 0 for fastest response.",
          ),
        wait_for: z
          .string()
          .optional()
          .describe(
            "CSS selector to wait for before extracting HTML (e.g. '#content'). Omit or leave empty for fastest response.",
          ),
      },
      safeHandler(async ({ url, delay_before_return, wait_for }) => {
        if (/\.pdf(\?|#|$)/i.test(url)) {
          return errorResult(
            "This URL appears to be a PDF, which this tool can't parse.",
          );
        }
        const hasDelay =
          typeof delay_before_return === "number" && delay_before_return > 0;
        const hasWaitFor =
          typeof wait_for === "string" && wait_for.trim().length > 0;

        // Route through /crawl ONLY when a non-zero delay or non-empty selector is requested
        if (hasDelay || hasWaitFor) {
          const payload: Record<string, unknown> = {
            urls: [url],
          };

          const crawler_config: Record<string, unknown> = {};

          if (hasWaitFor) {
            const selector = wait_for!.trim();
            crawler_config.wait_for =
              selector.startsWith("css:") || selector.startsWith("js:")
                ? selector
                : `css:${selector}`;
          }

          if (hasDelay) {
            const delayMs = Math.round(delay_before_return! * 1000);
            payload.hooks = {
              hooks: [
                {
                  action: "wait_for_timeout",
                  params: { timeout_ms: delayMs },
                },
              ],
            };
          }

          if (Object.keys(crawler_config).length > 0) {
            payload.crawler_config = crawler_config;
          }

          const result = await callEngine(this.env, "/crawl", payload);
          if (!result.ok) return errorResult(result.message);

          const pageResult = result.data.results?.[0];
          if (!pageResult || !pageResult.success) {
            return errorResult(
              pageResult?.error_message ?? "Failed to crawl page",
            );
          }

          const html = pageResult.cleaned_html || pageResult.html || "";
          return { content: [{ type: "text", text: html }] };
        }

        // Default fast route via /html (used when delay is 0/omitted and wait_for is empty/omitted)
        const result = await callEngine(this.env, "/html", { url });
        if (!result.ok) return errorResult(result.message);
        const text = result.data.html ?? JSON.stringify(result.data);
        return { content: [{ type: "text", text }] };
      }),
    );

    this.server.tool(
      "screenshot_page",
      "Capture a PNG screenshot of a webpage from top to bottom. Uses an expandable virtual viewport canvas to capture long pages quickly without timing out.",
      {
        url: z.string().url().describe("Full URL of the page to capture"),
        screenshot_wait_for: z
          .number()
          .default(1)
          .describe(
            "Seconds to wait after page load before taking the screenshot",
          ),
        viewport_height: z
          .number()
          .min(1000)
          .max(3500)
          .default(3000)
          .describe(
            "Height of the browser viewport in pixels. Increase for long pages to capture more vertical content in one image. Keep at or below ~3500 — taller values have failed in testing on visually dense pages (confirmed: Wikipedia's Berlin article failed at 4000 through the real connector, twice, while succeeding at 3000). If you need a taller capture, try it — this cap is conservative, not a hard engine limit — but treat failures as expected at the high end for image-heavy pages.",
          ),
      },
      safeHandler(async ({ url, screenshot_wait_for, viewport_height }) => {
        const payload: Record<string, unknown> = {
          urls: [url],
          browser_config: {
            viewport_width: 1920,
            viewport_height: viewport_height, // Expands virtual canvas to full page height
          },
          crawler_config: {
            screenshot: true,
            scan_full_page: false, // Keeps scroller disabled to prevent 100-step loop timeouts
            wait_until: "domcontentloaded",
            page_timeout: 15000,
          },
        };

        if (screenshot_wait_for > 0) {
          const delayMs = Math.round(screenshot_wait_for * 1000);
          payload.hooks = {
            hooks: [
              {
                action: "wait_for_timeout",
                params: { timeout_ms: delayMs },
              },
            ],
          };
        }

        const result = await callEngine(this.env, "/crawl", payload);
        if (!result.ok) return errorResult(result.message);

        const pageResult = result.data.results?.[0];
        if (!pageResult || !pageResult.success) {
          return errorResult(
            pageResult?.error_message ?? "Failed to capture page screenshot",
          );
        }

        let base64 = pageResult.screenshot;
        if (!base64) {
          return errorResult("Engine failed to generate screenshot");
        }

        if (base64.startsWith("data:")) {
          base64 = base64.replace(/^data:image\/\w+;base64,/, "");
        }

        return {
          content: [{ type: "image", data: base64, mimeType: "image/png" }],
        };
      }),
    );

    this.server.tool(
      "execute_js",
      "Execute a sequence of JavaScript snippets on the specified URL. Return the full CrawlResult JSON (first result). Use this when you need to interact with dynamic pages using JS. REMEMBER: Scripts accept a list of separated JS snippets to execute and execute them in order. IMPORTANT: Each script should be an expression that returns a value. It can be an IIFE or an async function. You can think of it as such. Your script will replace '{script}' and execute in the browser context. So provide either an IIFE or a sync/async function that returns a value. Return Format: - The return result is an instance of CrawlResult, so you have access to markdown, links, and other stuff. If this is enough, you don't need to call again for other endpoints. ```python class CrawlResult(BaseModel): url: str html: str success: bool cleaned_html: Optional[str] = None media: Dict[str, List[Dict]] = {} links: Dict[str, List[Dict]] = {} downloaded_files: Optional[List[str]] = None js_execution_result: Optional[Dict[str, Any]] = None screenshot: Optional[str] = None pdf: Optional[bytes] = None mhtml: Optional[str] = None _markdown: Optional[MarkdownGenerationResult] = PrivateAttr(default=None) extracted_content: Optional[str] = None metadata: Optional[dict] = None error_message: Optional[str] = None session_id: Optional[str] = None response_headers: Optional[dict] = None status_code: Optional[int] = None ssl_certificate: Optional[SSLCertificate] = None dispatch_result: Optional[DispatchResult] = None redirected_url: Optional[str] = None network_requests: Optional[List[Dict[str, Any]]] = None console_messages: Optional[List[Dict[str, Any]]] = None class MarkdownGenerationResult(BaseModel): raw_markdown: str markdown_with_citations: str references_markdown: str fit_markdown: Optional[str] = None fit_html: Optional[str] = None ```",
      {
        url: z.string().url().describe("Full URL of the page to load first"),
        scripts: z
          .array(z.string())
          .describe("JavaScript snippets to execute, in order"),
      },
      safeHandler(async ({ url, scripts }) => {
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
      }),
    );

    this.server.tool(
      "crawl_urls",
      "Crawl a list of URLs (up to 20) and return results for each as JSON, including JavaScript-rendered content. Use for fetching multiple pages in one call rather than one at a time.",
      {
        urls: z
          .array(z.string().url())
          .min(1)
          .max(20)
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
        delay_before_return: z
          .number()
          .optional()
          .describe(
            "Seconds to wait after page load before extracting content, applied to every URL in this batch (e.g. 2.5). Omit for fastest response.",
          ),
        wait_for: z
          .string()
          .optional()
          .describe(
            "CSS selector to wait for before extracting, applied to every URL in this batch. Omit for fastest response.",
          ),
      },
      safeHandler(async ({ urls, output, delay_before_return, wait_for }) => {
        const payload: Record<string, unknown> = { urls };
        const crawler_config: Record<string, unknown> = {};

        if (typeof wait_for === "string" && wait_for.trim().length > 0) {
          const selector = wait_for.trim();
          crawler_config.wait_for =
            selector.startsWith("css:") || selector.startsWith("js:")
              ? selector
              : `css:${selector}`;
        }
        payload.crawler_config = crawler_config;

        if (
          typeof delay_before_return === "number" &&
          delay_before_return > 0
        ) {
          const delayMs = Math.round(delay_before_return * 1000);
          payload.hooks = {
            hooks: [
              { action: "wait_for_timeout", params: { timeout_ms: delayMs } },
            ],
          };
        }

        const result = await callEngine(this.env, "/crawl", payload);
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
      }),
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
        max_results: z
          .number()
          .min(1)
          .max(20)
          .default(10)
          .describe("How many results to return (1-20, default 10)."),
      },
      safeHandler(async ({ query, time_range, language, max_results }) => {
        const params: Record<string, string> = { q: query, format: "json" };
        if (time_range) params.time_range = time_range;
        if (language) params.language = language;

        const result = await callSearxng(this.env, "/search", params);
        if (!result.ok) return errorResult(result.message);

        const results = (result.data.results ?? [])
          .slice(0, max_results)
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
      }),
    );

    this.server.tool(
      "image_search",
      "Search the web for images matching a query. Returns title, source page URL, and the direct image URL for each result.",
      {
        query: z.string().describe("The search query"),
        max_results: z
          .number()
          .min(1)
          .max(20)
          .default(10)
          .describe("How many results to return (1-20, default 10)."),
      },
      safeHandler(async ({ query, max_results }) => {
        const result = await callSearxng(this.env, "/search", {
          q: query,
          format: "json",
          categories: "images",
        });
        if (!result.ok) return errorResult(result.message);

        const results = (result.data.results ?? [])
          .slice(0, max_results)
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
      }),
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
        max_results: z
          .number()
          .min(1)
          .max(20)
          .default(10)
          .describe("How many results to return (1-20, default 10)."),
      },
      safeHandler(async ({ query, time_range, max_results }) => {
        const params: Record<string, string> = {
          q: query,
          format: "json",
          categories: "news",
        };
        if (time_range) params.time_range = time_range;

        const result = await callSearxng(this.env, "/search", params);
        if (!result.ok) return errorResult(result.message);

        const results = (result.data.results ?? [])
          .slice(0, max_results)
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
      }),
    );

    this.server.tool(
      "search_suggestions",
      "Get autocomplete query suggestions for a partial search term — useful for query refinement before a full search.",
      { query: z.string().describe("Partial search term") },
      safeHandler(async ({ query }) => {
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
      }),
    );

    this.server.tool(
      "search_instance_info",
      "Discover the search categories, engines, and plugins available on this SearXNG instance.",
      {},
      safeHandler(async () => {
        const result = await callSearxng(this.env, "/config", {});
        if (!result.ok) return errorResult(result.message);

        // Trimmed from SearXNG's full /config dump down to what a model
        // actually needs to pick a category or engine. Field names match
        // SearXNG's documented /config shape — unverified against this
        // specific instance, worth a quick diff the first time this runs.
        const d = result.data;
        const trimmed = {
          categories: d.categories ?? [],
          engines: (d.engines ?? [])
            .filter((e: any) => e.enabled !== false)
            .map((e: any) => ({ name: e.name, categories: e.categories })),
          plugins: (d.plugins ?? [])
            .filter((p: any) => p.enabled !== false)
            .map((p: any) => p.name),
        };

        return {
          content: [{ type: "text", text: JSON.stringify(trimmed, null, 2) }],
        };
      }),
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
