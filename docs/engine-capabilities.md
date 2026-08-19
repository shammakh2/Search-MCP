# Engine capabilities — what we've actually confirmed

This is a record of things we tested by hand against crawl4ai container, because the docs and the reject-list don't always agree with what the server actually does. Re-run the tests at the bottom after any `:latest` pull before trusting this again.

**Test URL used throughout:** `https://en.wikipedia.org/wiki/Berlin`. Big,
mostly-static, text-heavy page — good for comparing output sizes, but it's
not a hard case. Test with hard case later.

## `markdown_generator` / `content_filter` on `/crawl`

You _can_ send nested config objects in the shape
`{"type": "ClassName", "params": {...}}` inside `crawler_config`. Isn't obvious from the docs.

We confirmed two filters work correctly:

- **`PruningContentFilter`** with bare `params: {}` reproduces `/md`'s own
  `f=fit` output almost exactly — 312,751 chars from `/md` vs 315,095 from
  the reconstructed `/crawl` call, same text from the first
  character. No threshold tuning needed. The bare default is right.
- **`BM25ContentFilter`** with `params: {user_query: "..."}` returns a
  query-scoped excerpt — not empty, not the whole page. Works as expected.

## The trap: no filter ≠ pruned filter

If you build a `/crawl` request with **no** `content_filter` — or skip `markdown_generator`
entirely — you don't get some sane default pruning. You get an **empty
string** for `fit_markdown`. Only `raw_markdown` comes back populated.

We only found this because our old code's fallback chain was
`fit_markdown || raw_markdown || ...`, which means every `fetch_page` call
that set `wait_for` or `delay_before_return` had been silently returning
the _entire unfiltered page_ — nav bars, edit links, coordinate boilerplate,
all 509KB of it on the Berlin test.

Lesson for future tools: if a code path can produce an empty
`fit_markdown`, don't let anything fall through to raw content silently.
Error out instead. An empty result is more honest than a wrong one.

## Not tested / still open

- **`browser_config.viewport_height`** — does the hardened server clamp
  it, and does it actually control screenshot coverage the way
  `screenshot_page`'s description currently claims? Different config
  surface than `crawler_config`, so nothing above tells us anything here.
  Needs its own test: same tall page, viewport 3000 vs 8000, compare
  output PNG dimensions.
- **`/hooks/info`** — never actually pulled this to confirm the
  `wait_for_timeout` hook's param is really called `timeout_ms`. We've
  been assuming it. Should check before trusting `delay_before_return`
  too much.
- **`f='llm'`** — dropped entirely, we don't run an LLM alongside this.
- **The `raw:` prefix on `/md`** (feeding already-rendered HTML back
  through `/md` for extraction) — never tested. Matters if the
  `markdown_generator` reconstruction above ever turns out to be wrong on
  a harder page and we need a fallback approach.

## How to re-check this after an upgrade

```bash
T=$CRAWL4AI_API_TOKEN
URL="https://en.wikipedia.org/wiki/Berlin"

# baseline: /md's own f=fit
curl -s -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d "{\"url\":\"$URL\",\"f\":\"fit\"}" \
  localhost:11235/md | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('markdown','')))"

# reconstructed fit via /crawl — should land within ~1% of the above
curl -s -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d "{\"urls\":[\"$URL\"],\"crawler_config\":{\"markdown_generator\":{\"type\":\"DefaultMarkdownGenerator\",\"params\":{\"content_filter\":{\"type\":\"PruningContentFilter\",\"params\":{}}}}}}" \
  localhost:11235/crawl | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['results'][0]['markdown']['fit_markdown']))"

# the trap, still there? no filter should still come back empty on fit_markdown
curl -s -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d "{\"urls\":[\"$URL\"],\"crawler_config\":{}}" \
  localhost:11235/crawl | python3 -c "import json,sys; d=json.load(sys.stdin)['results'][0]['markdown']; print('raw:',len(d.get('raw_markdown','') or ''),'fit:',len(d.get('fit_markdown','') or ''))"
```

If any of these numbers move a lot after an upgrade, something changed
server-side and the tool code in `index.ts` needs a re-look.
