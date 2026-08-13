# search-mcp

A self-hosted MCP (Model Context Protocol) server for fetching and
extracting content from JavaScript-rendered webpages, using crawl4ai
as the scraping engine.

## Structure

- `engine/` — crawl4ai Docker Compose service (the scraper)
- `worker/` — auth shim + proxy exposing it over the tunnel

## Status

🚧 Scaffolding only. No engine or worker code yet.
