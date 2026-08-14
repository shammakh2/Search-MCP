# search-mcp

A self-hosted MCP (Model Context Protocol) server for searching the web
and fetching content from JavaScript-rendered webpages, exposed as a
Claude-compatible remote connector via a Cloudflare Worker.

## Structure

- `engine/` — Docker Compose services for the underlying tools:
  - crawl4ai — JS-rendered page fetching (Playwright-backed)
  - SearXNG + Redis — self-hosted metasearch
- `worker/` — Cloudflare Worker: OAuth 2.1 shim (passphrase-gated) + MCP
  tool definitions, proxying requests to the engine services

## Architecture

```
Client (Claude, Inspector, etc.)
   --OAuth 2.1--> Cloudflare Worker (passphrase gate + MCP tools)
   --HTTPS, via Cloudflare Tunnel--> self-hosted engine containers
```

The Worker is the only public-facing piece with authentication in front of
it. Engine containers are reachable solely through the tunnel's routes.

## Status

- ✅ **Fetch**: `fetch_page`, `fetch_html`, `screenshot_page`, `crawl_urls`
  — working, backed by crawl4ai. `execute_js` wired but disabled by
  default (crawl4ai's own safety gate).
- ✅ **Search**: `web_search`, `image_search`, `news_search`,
  `search_suggestions`, `search_instance_info` — working, backed by
  SearXNG.
- ⚠️ **Known gap**: the SearXNG route currently has no authentication of
  its own (its bot-detection limiter was deliberately disabled for
  automated use, and no replacement auth was added). Lower stakes than
  crawl4ai's fetch surface, but real — anyone who discovers the tunnel
  hostname can query it directly, bypassing the Worker's passphrase gate.
  Worth closing before treating this as done.

## Setup

1. **`engine/`** — for each service:
   - copy `.env.example` → `.env`, generate and set a real
     `CRAWL4AI_API_TOKEN`
   - copy `searxng-config/settings.yml.example` →
     `searxng-config/settings.yml`, generate and set a real `secret_key`
   - `docker compose up -d`
2. **Cloudflare Tunnel** — one named tunnel, one route per engine service,
   each pointing at the container's Compose service name (not
   `localhost`) on its internal port.
3. **`worker/`**:
   - `npm install`
   - `cp wrangler.example.jsonc wrangler.jsonc`,
     `wrangler kv namespace create OAUTH_KV`, paste the ID in
   - `cp .dev.vars.example .dev.vars`, fill in real local values
   - test locally with `npm run dev` + MCP Inspector before deploying
4. `npx wrangler deploy`, then set every secret again for production —
   `.dev.vars` only applies locally (see `worker/README.md`).
5. Add the deployed Worker's URL + `/mcp` as a custom connector in
   Claude, authenticate with the passphrase from step 3.
