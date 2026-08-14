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
  an engine's REST/JSON API — not either engine's own bundled MCP server,
  since neither speaks a transport Claude reliably supports end to end.

## Tools currently available

| Tool                   | Backed by                           | Notes                                                |
| ---------------------- | ----------------------------------- | ---------------------------------------------------- |
| `fetch_page`           | crawl4ai `/md`                      | Clean markdown, JS-rendered                          |
| `fetch_html`           | crawl4ai `/html`                    | Sanitized HTML                                       |
| `screenshot_page`      | crawl4ai `/screenshot`              | Returns a PNG                                        |
| `execute_js`           | crawl4ai `/execute_js`              | Disabled by default on the engine side               |
| `crawl_urls`           | crawl4ai `/crawl`                   | Batch fetch, up to 100 URLs                          |
| `web_search`           | SearXNG `/search`                   | General query → ranked results (title, URL, snippet) |
| `image_search`         | SearXNG `/search?categories=images` | Title, source URL, image URL                         |
| `news_search`          | SearXNG `/search?categories=news`   | Recent articles, with publish date where available   |
| `search_suggestions`   | SearXNG `/autocompleter`            | Query autocomplete                                   |
| `search_instance_info` | SearXNG `/config`                   | Instance's configured engines/categories/plugins     |

## Secrets (set via `wrangler secret put <NAME>`, not committed)

- `COOKIE_ENCRYPTION_KEY` — random string, `openssl rand -hex 32`
- `ACCESS_PASSPHRASE` — the passphrase gating access to this server
- `CRAWL4AI_ENGINE_URL` — tunnel hostname for the crawl4ai container
- `CRAWL4AI_API_TOKEN` — must match the token set in the engine's `.env`
- `SEARXNG_URL` — tunnel hostname for the SearXNG container

## Local development

```bash
npm install
cp wrangler.example.jsonc wrangler.jsonc    # your real, gitignored config
npx wrangler kv namespace create OAUTH_KV   # paste the ID into wrangler.jsonc
cp .dev.vars.example .dev.vars              # fill in real local values
npm run dev
```

`wrangler.jsonc` itself is gitignored (see `wrangler.example.jsonc`) — the
KV namespace ID isn't sensitive, just account-specific, so it's kept out
of the committed template.

Test with `npx @modelcontextprotocol/inspector` against
`http://localhost:8788/mcp`, Streamable HTTP transport.

## Deploy

```bash
npx wrangler deploy
```

Note: local dev reads secrets from `.dev.vars`; a real deploy does not —
each secret above needs to be set again via `wrangler secret put` before
the deployed Worker has access to it.

## Custom domain (optional)

By default the Worker is reachable at `<name>.<subdomain>.workers.dev`.
To use your own domain instead: Dashboard → Worker → Settings → Domains
& Routes → Add → Custom Domain. Works alongside the `workers.dev`
address rather than replacing it — either can be used as the connector
URL in Claude.
