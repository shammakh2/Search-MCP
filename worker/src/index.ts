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
      "Fetch a webpage and return sanitized, preprocessed HTML — use when you need structured markup rather than markdown, e.g. for building extraction schemas.",
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
        const imageResponse = await fetch(artifactUrl, {
          headers: { Authorization: `Bearer ${this.env.CRAWL4AI_API_TOKEN}` },
        });
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
      "Crawl a list of URLs (up to 100) and return results for each as JSON. Use for fetching multiple pages in one call rather than one at a time.",
      {
        urls: z
          .array(z.string().url())
          .min(1)
          .max(100)
          .describe("URLs to crawl"),
      },
      async ({ urls }) => {
        const result = await callEngine(this.env, "/crawl", { urls });
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
