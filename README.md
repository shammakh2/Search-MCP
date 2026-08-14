# search-mcp

A self-hosted MCP (Model Context Protocol) server for fetching and
extracting content from JavaScript-rendered webpages, exposed as a
Claude-compatible remote connector via a Cloudflare Worker.

## Structure

- `engine/` — Docker Compose services for the underlying tools (currently
  crawl4ai for JS-rendered page fetching; SearXNG planned for search)
- `worker/` — Cloudflare Worker: OAuth 2.1 shim (passphrase-gated) + MCP
  tool definitions, proxying requests to the engine services

## Architecture

```
Client (Claude, Inspector, etc.)
   --OAuth 2.1--> Cloudflare Worker (passphrase gate + MCP tools)
   --HTTPS, via Cloudflare Tunnel--> self-hosted engine container(s)
```

The Worker is the only public-facing piece. Engine containers are reachable
solely through the tunnel's routes, never exposed directly.

## Status

- ✅ Fetch: `fetch_page`, `fetch_html`, `screenshot_page`, `crawl_urls` —
  working, backed by crawl4ai. `execute_js` wired but disabled by default
  (crawl4ai's own safety gate).
- 🚧 Search: not yet implemented — planned via SearXNG.

## Setup

1. `engine/` — bring up the Docker Compose stack (`docker compose up -d`),
   generate and set a local API token in `.env` (see `.env.example`).
2. Route the engine's port through a Cloudflare Tunnel (Routes tab of a
   named tunnel, pointing at the container's Compose service name).
3. `worker/` — `npm install`, set secrets via `wrangler secret put`
   (see `worker/README.md`), `wrangler kv namespace create OAUTH_KV`,
   `wrangler deploy`.
4. Add the deployed Worker's URL + `/mcp` as a custom connector in Claude,
   authenticate with the passphrase set in step 3.
