# search-mcp worker

The public-facing half of `search-mcp` — a Cloudflare Worker that acts as
an OAuth 2.1 authorization server for MCP clients, then proxies
authenticated tool calls to self-hosted engine containers over a
Cloudflare Tunnel.

## Why the OAuth layer exists

Claude's Web and mobile clients require remote MCP connectors to
authenticate via OAuth 2.1 — a static API key isn't reliably supported in
their connector UI. Since this is a single-user server, the "identity
provider" is just a passphrase you set yourself, not a third party like
GitHub or Google — no external account dependency, no upstream OAuth
quirks to inherit.

## How it works

- `@cloudflare/workers-oauth-provider` handles the OAuth 2.1 mechanics
  (authorize/token endpoints, PKCE, client registration).
- `src/auth-handler.ts` implements the one custom piece: a passphrase
  form instead of a third-party login screen. CSRF-protected, approved
  clients remembered for 30 days via a signed cookie.
- `src/index.ts` defines the actual MCP tools, each a thin wrapper calling
  an engine's REST API — not crawl4ai's own bundled MCP server, which
  only speaks the legacy SSE transport Claude doesn't reliably support.

## Tools currently available

| Tool              | Backed by              | Notes                                  |
| ----------------- | ---------------------- | -------------------------------------- |
| `fetch_page`      | crawl4ai `/md`         | Clean markdown, JS-rendered            |
| `fetch_html`      | crawl4ai `/html`       | Sanitized HTML                         |
| `screenshot_page` | crawl4ai `/screenshot` | Returns a PNG                          |
| `execute_js`      | crawl4ai `/execute_js` | Disabled by default on the engine side |
| `crawl_urls`      | crawl4ai `/crawl`      | Batch fetch, up to 100 URLs            |

## Secrets (set via `wrangler secret put <NAME>`, not committed)

- `COOKIE_ENCRYPTION_KEY` — random string, `openssl rand -hex 32`
- `ACCESS_PASSPHRASE` — the passphrase gating access to this server
- `CRAWL4AI_ENGINE_URL` — the tunnel hostname for the crawl4ai container
- `CRAWL4AI_API_TOKEN` — must match the token set in the engine's own `.env`

## Local development

`wrangler.jsonc` itself is gitignored (see `wrangler.example.jsonc`) — the
KV namespace ID isn't sensitive, just account-specific, so it's kept out
of the committed template. Copy the example and fill it in before running
anything below.

```bash
npm install
cp wrangler.example.jsonc wrangler.jsonc    # your real, gitignored config
npx wrangler kv namespace create OAUTH_KV   # paste the ID into wrangler.jsonc
cp .dev.vars.example .dev.vars              # fill in real local values
npm run dev
```

Test with `npx @modelcontextprotocol/inspector` against
`http://localhost:8788/mcp`, Streamable HTTP transport.

## Deploy

```bash
npx wrangler deploy
```

Note: local dev reads secrets from `.dev.vars`; a real deploy does not —
each secret above needs to be set again via `wrangler secret put` before
the deployed Worker will have access to it.
