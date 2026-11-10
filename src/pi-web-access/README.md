# Pi Web Access

Web search, page/PDF extraction, GitHub access, and video understanding. This is the **Metis-maintained copy**; install and build it from the [repository root](../../README.md), not as a second `pi-web-access` extension. See [maintenance notes](METIS.md) for provenance and delivery boundaries.

Metis exposes one deferred `web_access` tool. The operation names below (`web_search`, `fetch_content`, `get_search_content`, `source_check`) are the standalone extension/MCP interfaces; Metis maps them to `search`, `fetch`, `content`, and `source_check` actions. All entrypoints share the same configuration owner.

## Why Pi Web Access

- **Search without a new key:** Exa MCP works out of the box; OpenAI search can reuse Pi's ChatGPT login. Other providers and their billing/selection rules are listed once under [Configuration](#configuration).
- **Retrieve evidence:** full search results and fetched pages remain addressable by `responseId`; source checks retain passage-level provenance without inventing semantic verdicts.
- **More than HTML:** GitHub code URLs return real repository contents; PDFs become Markdown; YouTube/local videos support analysis and timestamped frames.
- **Controlled fallbacks:** ordered search routes, explicit-only paid/quota-backed providers, local target validation, and opt-in hosted page extraction.
- **Other agents:** the maintained build also serves the four operations over [MCP stdio](#use-from-other-agents-mcp).

## Install

Run the Pi extension on **Pi 1.5.1 only**, following the root installation instructions. Disable a separately installed `pi-web-access` copy so tools, commands, and caches have one owner.

Ordinary preferences belong in `[webAccess]` in the global `<agentDir>/metis-pi.toml`; credentials remain in `<agentDir>/web-search.json`, environment variables, or trusted credential commands. `PI_CODING_AGENT_DIR` selects the agent directory. `/metis-config init` creates defaults and the parameter guide without importing or rewriting old files. Ordinary JSON preference fields are ignored by Metis.

Optional dependencies:

| Dependency | Used for | Without it |
| --- | --- | --- |
| `ffmpeg` / `ffprobe` | Video thumbnails, duration, timestamped frames | Gemini content analysis still works |
| `yt-dlp` | YouTube stream URLs for frame extraction | Gemini YouTube analysis still works |
| `xdg-utils` on Linux | Opening the curator browser | The running curator URL is printed |
| `gh` | Private GitHub access and richer PR/issue views | Public clone/REST paths remain available |

For example, install `ffmpeg` and `yt-dlp` with your OS package manager; Debian/Ubuntu browser launch support is `sudo apt install -y xdg-utils`.

### Reuse the selected Pi provider URL

By default, independent OpenAI search uses the official endpoint and refuses Pi credentials associated with a custom `baseUrl`. To use a Responses-compatible gateway, either set the full `openaiResponsesUrl` or enable provider URL reuse:

```toml
[webAccess]
openaiSearchProviders = ["my-openai-provider"]
openaiUseProviderBaseUrl = true
```

`openaiUseProviderBaseUrl` defaults to `false` and must be boolean. An explicit `openaiResponsesUrl` takes precedence. Reuse avoids copying the gateway address from `models.json`. Otherwise each search resolves credentials and URL together; the auth-resolved base beats the model base, and unusable candidates are skipped in configured order. Reload Pi after changing its provider configuration. Gateway Responses/`web_search` support is not inferred.

Only absolute HTTP(S) URLs are accepted. Origin, port, prefix, and query parameters are preserved:

| Provider base | Derived endpoint |
| --- | --- |
| `https://gateway.example.com` or `https://gateway.example.com/v1` | `https://gateway.example.com/v1/responses` |
| `https://gateway.example.com/team/v1/` | `https://gateway.example.com/team/v1/responses` |
| `https://gateway.example.com/v1/responses` | Unchanged |

Official Codex auth at `https://chatgpt.com/backend-api` uses `/backend-api/codex/responses`. Reused custom Codex URLs retain their destination and account headers. If no Pi candidate has usable credentials and a valid base, reuse mode fails closed: no official-endpoint or standalone-key fallback. API-key-only gateways can use `openaiResponsesUrl`. This switch does not broaden `searchRouting.useCurrentModel` eligibility. With reuse disabled, existing Codex endpoint selection remains; an explicit endpoint deliberately overrides the custom-base safeguard, even if it names the official endpoint.

### Optional OpenAI standalone search

```toml
[webAccess]
openaiUseAlphaSearch = true
openaiResponsesUrl = "https://gateway.example.com/v1/responses"
openaiSearchProviders = ["my-openai-provider"]
```

`openaiUseAlphaSearch` is boolean, default `false`. It replaces a selected `/responses` suffix (optional trailing slash) with `/alpha/search`, preserving the rest of the URL. Official Codex auth defaults to `https://chatgpt.com/backend-api/codex/alpha/search`; provider URL reuse follows that provider instead. Credential selection, model overrides, custom-base safeguards, and official current-model eligibility still apply; the flag cannot make an arbitrary gateway implement this protocol.

Requests use `id`, `model`, and `commands.search_query`, not a Responses tool call. Plaintext `output` and structured `text_result` sources return without another summary-model call; encrypted-only responses are rejected. Results default to 5, deduplicate, and cap at 20. Recency maps to 1/7/30/365 days; positive domain filters map to `domains`, but exclusions are explicitly unsupported.

HTTP 404/405/501 and excluded-domain requests follow the `unsupported` fallback policy. There is **no automatic Responses retry**. Explicit `provider: "openai"` remains strict; cancellation, proxy transport, and the 60-second deadline remain in force. Configure an ordered route to allow another provider:

```toml
[webAccess.searchRouting]
providers = ["openai", "tavily"]
useCurrentModel = true
fallbackOn = ["unsupported", "transient", "quota", "network", "invalid-response"]
```

Do not also set a top-level provider when using this route. `useCurrentModel` applies only to active GPT models on official HTTPS OpenAI Responses or ChatGPT Codex endpoints (`openai`/`openai-responses`, `openai-codex`/`openai-codex-responses`). Azure, gateways, and other models continue to the next route entry. A tool-level or top-level provider is an explicit override; named OpenAI search keeps its independent search-model selection.

## Quick Start

In Metis codemode:

```javascript
const result = await tools.web_access({ action: "search", params: { query: "TypeScript documentation" } });
text(result);
```

Equivalent standalone operations:

```typescript
web_search({ query: "TypeScript documentation" })
fetch_content({ url: "https://docs.example.com/guide" })
fetch_content({ url: "https://github.com/owner/repo" })
fetch_content({ url: "https://youtube.com/watch?v=abc", prompt: "What libraries are shown?" })
fetch_content({ url: "/path/to/recording.mp4", prompt: "What error appears?" })
```

## Tools

### web_search

The default `workflow: "none"` returns bounded raw results and the provider used, stores full results by `responseId`, opens no curator/browser, and makes no summary-generation call. A search provider may itself be model-backed.

| Parameter | Meaning |
| --- | --- |
| `query` / `queries` | One query or a batch; batches run up to 3 queries concurrently, preserving query order |
| `numResults` | Default 5, maximum 20; providers may impose smaller caps |
| `recencyFilter` | `day`, `week`, `month`, `year`; provider support is described below |
| `domainFilter` | Included domains or `-excluded.example`; provider-specific limitations still apply |
| `category` | Exa category such as `news` or `research paper`; ignored by other providers; keyless Exa appends it to the query if filtered search is unavailable |
| `provider` | Named provider, `auto`, `all`, or a non-empty array of names |
| `includeContent` | Preserve provider-returned page bodies and fetch missing content; ordinary Pi calls can fetch in the background |
| `workflow` | Per-call `none`, `summary-review`, or `auto-summary` override |
| `proxy` | Optional Web-only transport override |

Provider fallback is sequential within each query. Brave uses a process-local queue based on reported `X-RateLimit-*` buckets: short waits include a safety margin, long quota waits fail fast and establish cooldown, and a 429 can retry once using `Retry-After`. Its 30-second deadline includes queueing, cooldown, and attempts; separate Pi processes do not coordinate that queue.

### fetch_content

| Parameter | Meaning |
| --- | --- |
| `url` / `urls` | One URL/path or a parallel batch; content fetch concurrency is 3 |
| `mode` | `readable` (default), direct HTTP `raw`, or page-local `answer` |
| `prompt` / `answerModel` | Question for answer/video analysis; optional per-call answer-model override |
| `model` | Per-call Gemini model override for video/YouTube analysis |
| `timestamp` / `frames` | Video frame selection; at most 12 frames |
| `forceClone` | Override the 350 MB GitHub clone threshold |
| `auth` | Explicit local browser-cookie profile; see [Blocked pages](#blocked-pages) |
| `proxy` | Per-call proxy; `""` forces direct transport |

Direct PNG/JPEG/WebP/GIF images are downloaded under the normal safety checks, resized when large, and returned as image blocks. GitHub, video, and PDF handling is detailed under [Capabilities](#capabilities).

Answer mode uses extracted page/PDF text, not a saved-file notice. A per-call `answerModel` wins over the configured `fetch.answerProvider` / `fetch.answerModel` pair, even if those defaults are malformed. Without configured defaults it uses the current Pi model. Configured defaults must be a complete, enabled, text-capable registry model pair or fail closed. This may send page text to another provider and incur its costs; a negative answer means “not found in extracted content,” not “absent from the whole page.” Thanks to @linuxtextadventurer for the configurable timeout and default answer-model contributions (upstream PRs #327/#328).

### get_search_content

Retrieve a stored search answer/source list, fetched page, or source-check artifact by `responseId`:

| Parameter | Meaning |
| --- | --- |
| `query` / `queryIndex` | Select a search query |
| `url` / `urlIndex` | Select a fetched page; optional when exactly one page is stored |
| `offset` / `limit` | Character pagination, with continuation guidance |
| `findText` | One non-empty string or up to 10 strings, each at most 500 characters |
| `findMode` | `exact`, `case-insensitive` (default), or `fuzzy` |

Do not combine `findText` with pagination. Passage search returns bounded context (20,000 characters), identifies overflowing queries as `Q1`, `Q2`, etc., prints each full query once, and reserves representative matches when spans fit. Oversized spans do not guarantee a representative. `maxInlineContentChars` bounds ordinary slices, including continuation guidance; full content remains stored.

Pi fetched-page bodies live in a private external cache, not session JSONL: 1-hour TTL, 128 entries / 128 MiB per cache, oldest-entry eviction. POSIX directories/files use 0700/0600. `PI_WEB_ACCESS_CACHE_ROOT` overrides the parent of `web-search-cache`; resumed sessions need the same cache. A configured `webAccess.cacheRoot` does not move old data. Missing/expired content is reported, not fabricated. MCP has a separate in-memory lifetime described below.

### source_check

Supply required `claim` and optional `queries` (default: the claim), `numResults`, `fetchContent`, recency/domain filters, provider, or proxy. Results deduplicate to at most 20 sources; `fetchContent` opts into fetching at most 5 pages for a machine-readable artifact. It retains page content hashes (SHA-256), passage IDs/offsets, source-quality metadata, errors, and an addressable `responseId`; long artifacts are paged through `get_search_content`.

The schema allows `supported`, `contradicted`, `unclear`, and `missing-evidence`, but retrieval alone does **not** establish support or contradiction. Current assessments are `unclear` when passages exist and `missing-evidence` otherwise; semantic review remains the caller's responsibility.

### In codemode scripts

Standalone Pi operations return structured data: `responseId`/`fetchId`, per-query `answer`/`provider`/`results`/`error` (sources carry `title`/`url`/`snippet`, plus available `inlineContent`), and full per-URL `content`/`error` rather than the inline text cap. Tool failures resolve with error data; invalid arguments reject. Script searches default to `none`; `includeContent` waits for retrieval before returning. Explicit review/auto-summary workflows retain their normal curator and fetch lifecycle. Metis callers use the grouped action API shown above.

## Use from other agents (MCP)

The maintained build offers local MCP stdio with `web_search`, `fetch_content`, `get_search_content`, and `source_check`. Use Node **22.19+** and the root-built bundle; Pi need not run or be installed as the MCP host. From a root source checkout, build with `npm run build:plugins` before configuring your client:

```json
{
  "mcpServers": {
    "web": {
      "command": "node",
      "args": ["/absolute/path/to/metis-pi/src/pi-web-access/dist/mcp-cli.js"],
      "env": { "BRAVE_API_KEY": "your-key" }
    }
  }
}
```

This is not the upstream `npx -y pi-web-access` artifact. The maintained bundle shares Metis TOML preferences and adjacent JSON/env/command credentials; it exposes only enabled default tool names and ignores Pi-only `toolNames` renaming. Restart it after config changes. The build bundles its standalone TypeBox runtime (see [maintenance notes](METIS.md)); install dependencies from the root rather than assembling a nested package.

MCP restrictions:

- No curator or summary workflows (`workflow` is ignored), Pi ChatGPT/current-model login, or Kimi Code Plan auth. Automatic routing uses standalone-capable providers; explicit unsupported selections return errors instead of substituting another provider.
- No answer mode, video/YouTube understanding, frames, or image results. Unsupported fetch modes/sources fail explicitly; readable/raw web pages, GitHub, and PDF text remain available.
- `includeContent` waits for fetches. The 50 most recent results are held in memory for retrieval and disappear when the server exits.

## Capabilities

### GitHub repos

Code URLs clone locally: roots return a tree/README, `/tree/` a directory listing, `/blob/` file content. Repositories over 350 MB use a lightweight API view unless `forceClone` is set; commit SHA URLs use the API. Public clones can use Git without `gh`; private access requires `gh`. Clones are session-scoped and cleaned when no live session still needs them.

PR/issue URLs produce priority-ordered Markdown rather than scraped HTML. PRs include status/body, checks when supported by `gh`, verdicts, references, files, commits, comments/review threads, truncation markers, and escalation commands. Issues include metadata, state, body, closing PRs when available, and comments. `#issuecomment-...` / `#discussion_r...` anchors are forced inline; full rendered documents support stored-content paging/find.

The path tries noninteractive `gh pr view` / `gh issue view`, retries a smaller field set for old `gh`, then bounded public REST under the same domain/SSRF policy. REST omits checks; review-thread resolution state is unknown. Branch names containing slashes can misresolve file paths; navigate the clone manually. Wiki/discussion and other non-code pages use ordinary extraction. `githubClone.enabled = false` and `githubPrIssue.enabled = false` disable only their specialization, not `fetch_content` or generic HTTP extraction.

### YouTube videos

Gemini returns visual descriptions, timestamped transcripts, and chapters; `prompt` asks a specific question. A thumbnail provides visual context. Fallback: Gemini Web (only with cookie opt-in) → Gemini API → Perplexity text summary. Recognized forms include `/watch?v=`, `youtu.be/`, `/shorts/`, `/live/`, `/embed/`, and `/v/`. Private/age-restricted videos may fail; Gemini may truncate videos beyond roughly one hour.

### Local video files

Paths starting `/`, `./`, `../`, or `file://` support common video formats (MP4/MOV/WebM/AVI) up to 50 MB for Gemini analysis: Gemini Files API → opt-in Gemini Web. A prompt and optional ffmpeg thumbnail are supported. Timestamp/frame extraction can operate on larger local files without sending them for Gemini analysis.

### Video frame extraction

```typescript
fetch_content({ url: "...", timestamp: "23:41" })
fetch_content({ url: "...", timestamp: "23:41-25:00", frames: 3 })
fetch_content({ url: "...", timestamp: "23:41", frames: 5 })
fetch_content({ url: "...", frames: 6 })
```

Requires `ffmpeg`/`ffprobe`, plus `yt-dlp` for YouTube. Timestamps accept `H:MM:SS`, `MM:SS`, or bare seconds. A range defaults to 6 frames; a single timestamp plus count samples at 5-second intervals; count alone samples the whole video. Distribution is endpoint-inclusive with at least 5-second spacing, at most 12 frames. Invalid/out-of-duration timestamps and unavailable binaries report specific errors rather than falling through to unrelated extraction.

### PDFs

Readable mode converts PDF URLs to Markdown under temporary `pi-web-pdf` storage and returns a file path; answer mode receives the extracted Markdown. Original content remains retrievable.

| `pdf.provider` | Engine and limits |
| --- | --- |
| `auto` (default) | Configured Datalab → configured Gemini → local `unpdf` |
| `datalab` | Hosted Marker conversion preserving tables, columns, headings, math; `accurate` supports scans; may return `parse_quality_score` (0–5) |
| `gemini` | Vision-based extraction for complex/scanned pages; transcription can drift or truncate |
| `unpdf` | Offline pdf.js text only, without layout, tables, or OCR |

Explicit remote engines skip the other remote tier but can fall back to `unpdf` on errors, **not** on credential/config errors or caller cancellation. No configured Datalab key simply skips that tier. `pdf.maxSizeMB` defaults to 20 (cap 50); `pdf.maxPages` defaults to 100 and limits every engine.

```toml
[webAccess.pdf]
provider = "auto"
maxSizeMB = 20
maxPages = 100
datalabMode = "balanced"
datalabTimeoutMs = 120000
```

Datalab credentials use `datalabApiKey` / `DATALAB_API_KEY`. Modes are `fast`, `balanced`, `accurate`; `pdf.datalabMode` overrides `DATALAB_MODE`. Timeout defaults to 120 seconds, capped at 300. `DATALAB_API_BASE` selects a gateway; `DATALAB_PROCESSING_LOCATION` is `us` by default or `eu`. Like Gemini, Datalab receives PDF bytes; uploaded files are deleted best-effort, not guaranteed immediately.

Upstream's pricing snapshot: fast/balanced $4 per 1,000 pages, accurate $10; monthly credit $10 for personal email / $20 for work email, with 25 requests/minute. Thus $10 covers about 2,500 fast or 1,000 accurate pages. EU processing uses 1.25× credit. These are provider terms, not local quotas or a current-price guarantee; check your account before sending documents.

### Blocked pages

Ordinary text, raw, and image HTTP paths share SSRF validation, hostname policy, redirect checks, timeout, and a **5 MB streamed decoded-body bound**. Raw returns text even for non-2xx statuses (reported in tool details), without readability, specialized source handling, or hosted fallback.

With insufficient readable content, the normal route tries configured Firecrawl/Crawl4AI and eligible hosted providers, then Gemini fallbacks. Set `fetchRouting.providers` to reorder/select `http`, `firecrawl`, `crawl4ai`, `jina`, `tinyfish`, `search1api`, `querit`, `kagi`, `ollama`, `parallel`, `parallel-mcp`, `brightdata`, and `gemini`. Default order is shown under [How It Works](#how-it-works); `parallel-mcp` requires explicit inclusion. Successful Bright Data Unlocker content, even a short consent/paywall stub, ends fallback because the request was billed.

Remote HTTP(S) targets **do not use third-party hosted extraction unless `fetchRouting.allowRemoteHostedProviders = true`**. Local preflight cannot control a provider's own DNS/redirects/egress. Configured self-hosted Firecrawl/Crawl4AI remain eligible; Firecrawl defaults to cache-only and requires a separate fresh-scrape opt-in.

Authenticated fetch is explicit: `auth: "work"`, or `auth: true` when exactly one profile exists. Enable browser access first, then configure:

```toml
[webAccess]
allowBrowserCookies = true

[webAccess.authFetch.work]
hosts = ["docs.company.com"]
chromeProfile = "Profile 2"
redirects = "same-origin"
cache = "off"
```

A profile can also be a host array. Object profiles support `hosts`, optional `chromeProfile`, `redirects: "same-origin"`, and `cache: "session" | "off"`. Auth fetch is local direct HTTP only, HTTPS only, restricted to configured hosts/subdomains, and refuses cross-origin redirects. Cookies and authenticated content never go to hosted extraction; challenges are reported without fallback.

`fetchContent.domainPolicy.allow` / `deny` accept bare hostnames matching themselves/subdomains; deny wins. Policy applies before HTTP target handling and each locally followed redirect, not local files/non-HTTP sources, and never weakens SSRF. Hosted services can still see different redirect chains; enable them only with suitable provider-side isolation.

Readable extraction handles Next.js RSC data and declared discovery relations (`service-desc`, `service-doc`, `service-meta`, `api-catalog`, `describedby`) from HTTP `Link` and HTML `link`/`a[rel]`. Content remains primary; empty shells exhaust extraction fallbacks before returning discovery links alone. Cloudflare challenge detection requires its header/scripts, not merely the words “Just a moment.”

#### Proxy (`proxy`)

`web_search`, `source_check`, and `fetch_content` accept HTTP(S), SOCKS4/4A/5/5H proxies (for example `socks5h://proxy.example.com:1080`). Configured/per-call proxy traffic uses `curl` to avoid Node-fetch/undici proxy compatibility problems. `proxy: ""` forces direct transport; omission uses `[webAccess].proxy`. Authenticated proxy URLs stay in adjacent credentials JSON. This affects **Web operations only**, never the host agent's model traffic.

```toml
[webAccess]
proxy = "http://proxy.example.com:4444"
```

Localhost, `127.0.0.1`, `[::1]`, and `NO_PROXY` matches bypass proxy transport. DNS-preflight exemptions are separately controlled by [SSRF exceptions](#ssrf-exceptions); setting a proxy alone does not disable target validation.

## How It Works

```text
Search: configured named provider / ordered route / automatic provider chain
Fetch:  local video → Gemini Files API → opt-in Gemini Web
        GitHub → clone/API or PR/issue rendering
        YouTube → opt-in Gemini Web → Gemini API → Perplexity text summary
        HTTP (prefers Markdown, except raw)
          PDF → Datalab → Gemini → unpdf → saved Markdown
          HTML → Readability / RSC / Defuddle
            → configured Firecrawl → configured Crawl4AI
            → hosted Jina → TinyFish → Search1API → Querit → Kagi → Ollama
            → Parallel → Bright Data Unlocker → Gemini URL Context / Web
          Other text/JSON/Markdown → direct text
```

Hosted fetch steps require the opt-in above. Provider availability, explicitly configured routes, cancellation, and credential/config failures can stop or change these paths; this diagram does not promise every fallback will run.

## Commands

### /websearch

Open the curator without a model round-trip; `/websearch query, query` prefills comma-separated searches, omission opens an empty page. Add searches, compare/select results, then approve a summary or send selected raw results. Timeout submits with a deterministic summary if no approved draft exists. “Approve + auto-summary remaining searches for this prompt” changes inherited review workflows until the run settles; explicit workflows win, open windows are unchanged, and the choice is not persisted.

### /curator

Toggle the next search workflow, or use `/curator on`, `off`, or `summary-review`. Save to global TOML; disabled means raw results without a curator window.

### /search

Browse this session's stored results and response IDs.

### /google-account

Report the active Gemini Web account or sanitized browser/profile/cookie-store diagnostics.

## Activity Monitor

**Ctrl+Shift+W** shows live API/page activity with query/URL, status, elapsed time, success/failure, and quota information. **Ctrl+Shift+S** opens curation. Both are configurable under `webAccess.shortcuts` and take effect after restart.

## Configuration

For scope/init/save rules see [Metis configuration](../../docs/configuration.md) and the [parameter guide](../../metis-pi-config.md). Missing TOML uses package defaults. To reuse an existing cache parent, set `webAccess.cacheRoot`; nothing is migrated or deleted.

Minimal preference example (provider credentials are separate):

```toml
[webAccess]
workflow = "none"
maxInlineContentChars = 30000
summaryGenerationDeadlineMs = 30000
allowBrowserCookies = false

[webAccess.fetch]
timeout = 30
defaultMode = "readable"
allowedModes = ["readable", "raw", "answer"]
```

### Environment variable precedence

Every key field below accepts a literal, `$NAME` / `${NAME}`, or trusted `!command`. Explicit sources override legacy env values and fail that provider locally if resolution fails; they never silently reuse an old key. Without an explicit source, the listed environment variable wins over a literal JSON value. `$$` / `$!` escape literal leading `$` / `!`.

**A** = eligible for automatic/all-provider selection when available; **E** = explicit-only (a named request/default/array or configured route). An allowlist cannot promote E to automatic selection. The table is also the supported provider list; Cloudflare/Datalab are credentials for gateways/PDFs, not search provider IDs.

| Provider ID | JSON credential → environment variable | Selection / additional setup |
| --- | --- | --- |
| `openai` | `openaiApiKey` → `OPENAI_API_KEY` | A; can use Pi auth instead |
| `brave` | `braveApiKey` → `BRAVE_API_KEY` | A |
| `parallel` | `parallelApiKey` → `PARALLEL_API_KEY` | A; REST API |
| `parallel-mcp` | Optional `parallelApiKey` → `PARALLEL_API_KEY` | E; keyless MCP or optional Bearer token |
| `tinyfish` | `tinyfishApiKey` → `TINYFISH_API_KEY` | A |
| `search1api` | `search1apiApiKey` → `SEARCH1API_KEY` | A |
| `searchinfinity` | `searchinfinityApiKey` → `SEARCHINFINITY_API_KEY` | A |
| `querit` | `queritApiKey` → `QUERIT_API_KEY` | A |
| `tavily` | `tavilyApiKey` → `TAVILY_API_KEY` | A; numbered-key pool below |
| `you` | `youApiKey` → `YDC_API_KEY` | E; paid API |
| `firecrawl` | `firecrawlApiKey` → `FIRECRAWL_API_KEY` | A when configured; base URL required |
| `jina` | `jinaApiKey` → `JINA_API_KEY` | A |
| `serpdive` | `serpdiveApiKey` → `SERPDIVE_API_KEY` | A; free `krill` default |
| `kagi` | `kagiApiKey` → `KAGI_API_KEY` | A |
| `bocha` | `bochaApiKey` → `BOCHA_API_KEY` | A |
| `ollama` | `ollamaApiKey` → `OLLAMA_API_KEY` | A; Cloud service, no local daemon |
| `anysearch` | Optional `anysearchApiKey` → `ANYSEARCH_API_KEY` | E; anonymous supported |
| `xcrawl` | `xcrawlApiKey` → `XCRAWL_API_KEY` | E |
| `valyu` | `valyuApiKey` → `VALYU_API_KEY` | E |
| `xai` | `xaiApiKey` → `XAI_API_KEY` | E; Pi registry auth preferred |
| `mistral` | `mistralApiKey` → `MISTRAL_API_KEY` | E; premium tool separately opt-in |
| `brightdata` | `brightdataApiKey` → `BRIGHTDATA_API_KEY` | E; separate SERP/Unlocker zones |
| `serpbase` | `serpbaseApiKey` → `SERPBASE_API_KEY` | E; paid Google SERP |
| `serpapi` | `serpapiApiKey` → `SERPAPI_KEY` | E; paid Google SERP |
| `serper` | `serperApiKey` → `SERPER_API_KEY` | E; Google Search API |
| `serply` | `serplyApiKey` → `SERPLY_API_KEY` | E; paid Google Search API |
| `baizhi` | `baizhiApiKey` → `BAIZHI_API_KEY` | E; commercial MCP credits |
| `zai` | `zaiApiKey` → `ZAI_API_KEY` | E; GLM Coding Plan quota |
| `keenable` | Optional `keenableApiKey` → `KEENABLE_API_KEY` | E; keyless rate-limited endpoint |
| `ceramic` | `ceramicApiKey` → `CERAMIC_API_KEY` | E; paid keyword search |
| `searxng` | Optional `searxngHeaders` in JSON | A; configured local endpoint preferred |
| `degoog` | Optional `degoogApiKey` → `DEGOOG_API_KEY` | E; public or self-hosted endpoint |
| `duckduckgo` | None | E; HTML search |
| `exa` | `exaApiKey` → `EXA_API_KEY` | A; keyless hosted MCP otherwise |
| `perplexity` | `perplexityApiKey` → `PERPLEXITY_API_KEY` | A |
| `gemini` | `geminiApiKey` → `GEMINI_API_KEY` | A via API/gateway; cookie-only access does not join `all` |
| `kimi` | Pi `/login kimi-coding` | E; shared Code Plan quota |
| PDF only | `datalabApiKey` → `DATALAB_API_KEY` | Hosted conversion |
| Gateway only | `cloudflareApiKey` → `CLOUDFLARE_API_KEY` | Gemini Cloudflare gateway auth |
| Fetch only | `crawl4aiApiToken` → `CRAWL4AI_API_TOKEN` | Configured Crawl4AI server |

Example `<agentDir>/web-search.json`:

```json
{
  "openaiApiKey": "!/absolute/path/to/secret-manager read openai",
  "braveApiKey": "${SCOPED_BRAVE_API_KEY}",
  "exaApiKey": "$$literal-key",
  "geminiApiKey": "$!literal-command"
}
```

Only provider credential fields use this syntax; endpoints, zones, and other fields are literal. Resolver commands run **per selected provider request**, not at registration, with a 5-second timeout, 16 KiB stdout limit, minimized environment, and one non-empty output line. Errors omit command text/stderr. Use absolute executables and protect config: these are trusted local commands, **not** a same-user isolation boundary.

`OP_SESSION_*` and `OP_SERVICE_ACCOUNT_TOKEN` are forwarded when present. A command such as `!/absolute/path/to/op read 'op://Automation/Brave/credential'` can use every permission granted to that account; the item URI is not an authorization boundary. Prefer a narrowly scoped service account. Direct Gemini keys use `x-goog-api-key`, never a URL query parameter.

### Provider endpoints and authentication

#### OpenAI

`openaiResponsesUrl` defaults to `https://api.openai.com/v1/responses`; gateway/reuse/alpha behavior is defined under [Install](#install). `openaiSearchProviders` defaults to `["openai-codex", "openai"]`, skipping unregistered/signed-out entries. An empty array skips Pi credentials and permits standalone-key fallback outside URL-reuse mode.

`openaiSearchModel` sends a pinned ID verbatim. Otherwise selection prefers newest Luna, then newest bare `gpt-N` / `gpt-N.N`, then other versioned GPT IDs; key-only fallback is `gpt-6-luna`. Search auth/endpoint are independent from summary-model selection.

#### Exa

Keyed requests use Exa account limits directly; old `exa-usage.json` is ignored. Without a key, hosted MCP supplies zero-config search. `exaBaseUrl` affects keyed API calls only.

`braveBaseUrl`, `exaBaseUrl`, and `tavilyBaseUrl` override official API roots; `BRAVE_BASE_URL`, `EXA_BASE_URL`, and `TAVILY_BASE_URL` take precedence. Brave appends `/web/search`; Exa/Tavily append `/search`. HTTPS is required remotely; explicit true-loopback endpoints can use HTTP. Invalid overrides fail before sending, and cross-origin redirects strip credential headers.

#### Gemini API

`geminiBaseUrl` / `GOOGLE_GEMINI_BASE_URL` (env wins) selects a bare generate-content host/prefix without version or trailing slash. A `gateway.ai.cloudflare.com` host uses `cf-aig-authorization: Bearer ...` with the Cloudflare key; generate-content then needs no Gemini key.

`geminiAuth = "adc"` instead uses Vertex AI (`aiplatform.googleapis.com`) with an OAuth token from `GOOGLE_APPLICATION_CREDENTIALS` or `~/.config/gcloud/application_default_credentials.json` (`gcloud auth application-default login`). `geminiProject` / `geminiLocation` fall back to `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` (or `GCLOUD_PROJECT`); both are required. `authorized_user` refresh-token and `service_account` JWT files work; tokens refresh by expiry and are redacted from errors.

ADC/gateways cover generate-content search, URL context, and PDF/inline data. YouTube/local video Files API paths still need a Gemini API key or fall back to opt-in Gemini Web; a gateway/ADC alone does not make Files API analysis available.

### Provider selection and routing

Precedence is per-call provider → configured `provider` / `searchProvider` → `searchRouting` → automatic chain. A configured single-provider field also applies when a call sends `auto`. Named providers are strict; arrays run those named providers concurrently through the aggregation path and cannot contain `auto` or `all`.

Automatic order: configured SearXNG first; then subscription-backed OpenAI when the active Pi model uses ChatGPT auth, otherwise Exa before OpenAI; then Brave → Parallel → TinyFish → Search1API → Searchinfinity → Querit → Tavily → Firecrawl → Jina → SERPdive → Kagi → Bocha → Ollama → Perplexity → Gemini API → opt-in Gemini Web. Unavailable candidates are skipped; explicit-only providers never enter this chain.

`searchRouting.providers` is an ordered sequence of names (not `all`). Only failures named in `fallbackOn` continue: `unsupported`, `transient`, `quota`, `network`, `invalid-response`. Exhausted routes preserve per-provider diagnostics. Availability checks can skip unavailable entries. There is no random, weighted, sticky, or cooldown routing policy. Current-model OpenAI routing retains the eligibility described above; changing provider in the curator updates the saved preference.

`webSearch.allowedProviders` is an optional non-empty, duplicate-free search allowlist. Explicit scalar/array requests outside it fail before a provider request; auto/all/routes/source checks/curator stay within it. Defaults or route entries outside it are invalid config. It does not promote explicit-only providers into auto/all and does not restrict fetch routes, answer models, or summary models.

### Tool names and workflows

`workflow` defaults to `none`; `summary-review` opens the curator with a draft.
Use `workflow: "auto-summary"` to generate a summary without opening the curator.
Per-call workflow overrides config; `/curator` saves the next default.

In the standalone extension, `toolNames` can opt into alternate public tool names for `webSearch`, `sourceCheck`, `fetchContent`, and `getSearchContent`; defaults are the four operation names above.
`webSearch.enabled = false` disables search and source-check registration unless a tool-specific gate overrides it; fetch/content tools remain available.
Metis keeps its grouped public entrypoint; MCP uses default names.

### Browser cookies and Gemini models

Browser access is **off by default**: enable `allowBrowserCookies = true` or `PI_ALLOW_BROWSER_COOKIES=1`. Disabled means no browser/password-store access. `browserCookies.browser` pins `helium`, `chrome`, `brave`, `arc`, `chromium`, or `edge` where supported; otherwise discovery scans stable browser/profile order for the first profile with required Gemini cookies. `browserCookies.profile` is a profile directory name, not an arbitrary path. The old top-level `chromeProfile` and `profilePath` are rejected; auth-fetch profile `chromeProfile` is a separate supported field.

macOS supports Helium/Chrome/Brave/Arc and may prompt for Keychain access. Linux checks Secret Service, then KWallet's standard safe-storage entry during KDE sessions. Windows Chrome/Edge v10 cookies use current-user DPAPI; v20 app-bound cookies are unsupported. Required cookie names are checked before password-store access; encryption passwords stay in-process. A temporary read-only database copy uses `node:sqlite`, or `sqlite3` / Python stdlib fallback. `/google-account` classifies SQLite, profile, cookie, password-store, and decryption failures without leaking secrets.

`searchModel` changes Gemini API grounded search only (default `gemini-3.6-flash`), not URL/YouTube/video defaults. `youtube.preferredModel` and `video.preferredModel` select their analysis models. Gemini Web uses separate private headers and defaults to `gemini-3.1-pro`; unsupported explicit Web models fail instead of silently downgrading.

### Summary models

Summaries and query rewriting resolve Pi registry routes and honor `enabledModels` / `--models`. Preferred defaults are Claude Haiku, Codex Luna, Codex Terra, Gemini 3.6 Flash, GPT-5 mini, then DeepSeek V4 Flash when available. No enabled summary model yields a deterministic no-billing summary, not an unrelated model call.

`summaryModel` pins a provider/model selector, optionally suffixed `:off`, `:minimal`, `:low`, `:medium`, `:high`, `:xhigh`, or `:max`. If several authenticated routes expose the same model, supply a full selector such as `openrouter/anthropic/claude-haiku-4-5`: ambiguity reports candidates rather than picking the first. The curator stays usable; auto-summary reports the resolution error without making a model call. Explicit selectors do not silently fall through preferred models.

`summaryInstructions` appends verbatim requirements (use one `- ` bullet per line) to both curator/auto-summary prompts. Missing, non-string, or blank values change nothing. Built-in source/weak-evidence/conflict guards remain; regeneration feedback is appended afterwards. Slow generation falls back to a phase-labeled deterministic summary under the configured deadline, preserving cancellation and model-resolution errors.

### Content and curator limits

| Preference | Default / contract |
| --- | --- |
| `summaryGenerationDeadlineMs` | `30000` ms; positive integer, capped at `600000` ms per model attempt |
| `maxInlineContentChars` | 30,000; integers 1,000–200,000; invalid/smaller values use the default; direct fetch and stored-content slice budget |
| `curatorTimeoutSeconds` | 20 local / 60 remote; max 600; adjustable in UI |
| `fetch.timeout` | 30 seconds for direct HTTP/Jina; positive finite fractional seconds allowed, rounded up to ≥1 ms; must fit Node's 2,147,483,647 ms timer |
| `fetch.defaultMode` / `fetch.allowedModes` | `readable` / all three modes; non-empty duplicate-free allowed list must contain the default |
| `fetch.answerProvider` / `fetch.answerModel` | Optional complete pair; enabled text-capable Pi model, per-call override wins |
| `githubClone.maxRepoSizeMB` / `githubClone.cloneTimeoutSeconds` | 350 MB / 30 seconds |
| `githubClone.clonePath` | `/tmp/pi-github-repos`; explicit path can expand leading `~` / home variables |
| `video.maxSizeMB` | 50 MB for analysis; frame-only handling is separate |
| `pdf.maxSizeMB` / `pdf.maxPages` | 20 MB (cap 50) / first 100 pages |

Invalid declared `fetch.timeout` fails closed naming `metis-pi.toml`; internal/per-call `timeoutMs` wins. Disabled modes fail before fetch/model execution, never substitute another mode. Remote fallbacks have independent budgets: Firecrawl/Crawl4AI/Kagi/Ollama/Unlocker 60 seconds, TinyFish up to 150, Gemini 120, Datalab 120 (cap 300). Perplexity has a client-side 10 requests/minute limit; other providers enforce their account limits.

### SSRF exceptions

Private/reserved destinations are blocked by default. `ssrf.allowRanges` permits narrow CIDR exceptions (for example `198.18.0.0/15` for TUN fake-IP); all-address `0.0.0.0/0` and `::/0` are rejected. Exceptions affect validation, not proxy transport.

`ssrf.trustEnvProxy = true` separately skips local DNS preflight **only** for hostnames routed through the configured Web proxy (HTTP(S), SOCKS5H/4A, including an identical per-call proxy). Without a configured proxy it can use valid HTTP(S) `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` routes selected by Web transport. A different per-call proxy still gets DNS validation. `NO_PROXY` matches still validate; localhost/literal private targets remain blocked. It is opt-in, not a general SSRF bypass or proxy setup switch.

### Kimi Code Plan

Run `/login kimi-coding` with an active plan; select `kimi` explicitly or in an array/route. It resolves Pi's `kimi-coding` model and refreshed OAuth credential, calling `POST https://api.kimi.com/coding/v1/search` with `text_query`, not Moonshot Open Platform `$web_search`. No separate platform key is used.

Recency has no native parameter and is not sent; count/domain filters apply locally to `search_results`. Usage draws on shared subscription quota without a per-request usage report, so Kimi is excluded from auto/all.

### All providers

`provider: "all"` concurrently runs every available **A** provider permitted by the allowlist; cookie-only Gemini is not sufficient. Explicit-only **E** providers remain excluded even when keyed or configured elsewhere. Naming an array is how to deliberately fan out to those providers.

Answers remain labeled by provider; URLs/inline content deduplicate; partial successes survive other failures. All-failed results return per-provider diagnostics. Curator All gives each provider an independently selectable card and badge, with disabled failure cards; summaries use only selected cards. Non-curator output keeps labeled answer sections.

### Jina Search

Keyed `https://s.jina.ai` search uses bounded `count`, included-domain `site` filters, and excluded-domain/recency query clauses. Without `includeContent` it requests metadata only; with it Jina visits pages and returns Markdown, increasing latency/token use. Its fixed endpoint has no base-URL preference. Jina Reader is a separate hosted fetch fallback.

### TinyFish

Built-in Search (`https://api.search.tinyfish.ai`) and Fetch (`https://api.fetch.tinyfish.ai`) support count/recency/domain filters; counts above 10 paginate, and inline content uses Fetch batches of 10. It sits after Parallel in auto search and after Jina in hosted fetch. Upstream's documented credit-free Free-plan limits were 30 searches/minute / 150 fetched URLs/minute, with a key still required; check current [Search](https://docs.tinyfish.ai/search-api/reference) / [Fetch](https://docs.tinyfish.ai/fetch-api/reference) terms.

### Search1API

Search supports shared filters; `includeContent` opts into Deep Search, otherwise it is never enabled. Hosted fetch uses Crawl. Basic search costs 1 credit, Deep Search adds 1 per successfully crawled page, Crawl costs 1, per upstream's [credit rules](https://www.search1api.com/docs/essentials/credits-and-limits). Search sits after TinyFish; Crawl after TinyFish before Querit/Parallel.

### Searchinfinity

Byteplus Searchinfinity is the Global edition of 豆包搜索. Shared count caps at 20 and domain filters at 5 includes / 5 excludes. Per-result summaries form the answer, falling back to snippets. Accounts share monthly free quota with the Custom edition; API-key requests document 5 QPS / 30-second server timeout. See the [API reference](https://docs.byteplus.com/api/docs/searchinfinity/Searchinfinity_API_Reference).

### Querit

Uses official [querit-python](https://github.com/querit-ai/querit-python) fields: `count`, `filters.sites`, and recency `filters.timeRange.date` (`d1`, `w1`, `m1`, `y1`). Inline/hosted content uses `POST /v1/contents` batches of 10, after Search1API. Search and Contents subscriptions are independent: successful search does not prevent `403 No active contents subscription` on fetch.

### AnySearch

Anonymous or keyed; sends only `{ query, max_results }`. Recency/domain/`includeContent` do not add API fields; returned `content` is exposed inline when requested. It remains explicit-only.

### XCrawl

Sends `{ engine: "google_search", q }` to its SERP endpoint; shared filters do not add API fields and domains are filtered locally. Provider timeout is retriable, not caller cancellation. Null titles fall back to the URL; snippets remain normal SERP snippets. It remains explicit-only.

### xAI (Grok)

Uses hosted Agent Tools at `https://api.x.ai/v1/responses`, with Pi registry auth first (SuperGrok/X Premium), then pay-as-you-go key. A query may fan out to roughly a dozen billed tool calls plus tokens; explicit-only selection prevents incidental spending of chat allowance.

`xaiSearchModel` pins the ID; registry selection skips retired/unknown candidates, while key-only defaults start at `grok-4.5` for web or `grok-4.6` with X Search. Requests send `{ model, input, tools }`. `xaiSearchTools` defaults to `["web_search"]`; opt into `["x_search"]` or both. The array must be non-empty with no duplicate/unknown tools. X Search can incur its own charges; per-call X handle/date/media fields are not exposed.

Count/recency/domain are prompt guidance, not tool parameters. Sources prefer `url_citation` annotations, then `web_search_call` / `x_search_call` source lists, then response citations. Old Live Search `search_parameters` on `/v1/chat/completions` is deprecated (HTTP 410).

### Mistral Conversations

Uses direct Bearer-authenticated `POST https://api.mistral.ai/v1/conversations`, no Mistral SDK. `mistralSearchModel` defaults to non-empty `mistral-small-latest`; `mistralSearchTool` accepts default `web_search` or explicitly entitled/cost-sensitive `web_search_premium`.

Conversation text becomes the answer; usable HTTP(S) `tool_reference` URLs become deduplicated sources. Count/domain limits apply locally; recency/domain/count are also prompt guidance because built-in tools lack those fields. It remains explicit-only.

### Bright Data

The account token is `brightdataApiKey` / `BRIGHTDATA_API_KEY`. **SERP** requires `brightdataSerpZone` / `BRIGHTDATA_SERP_ZONE` of type `serp`; **Web Unlocker** separately requires `brightdataUnlockerZone` / `BRIGHTDATA_UNLOCKER_ZONE` of type `unblocker`. No zone is guessed or substituted, and configuring one product does not enable the other. Missing/malformed settings mark that product unavailable before sending, without breaking unrelated providers. Token and zone setup: [API tokens](https://brightdata.com/cp/setting/users), [zones](https://brightdata.com/cp/zones).

SERP is explicit-only and paid per request regardless of usefulness. It submits a Google URL with `site:` / `-site:` and real `tbs=qdr:d|w|m|y` filters plus `brd_json=1` to `https://api.brightdata.com/request`, using `{ zone, format: "raw", data_format: "parsed_light" }`. Organic title/link/description become ranked sources and a source-assembled answer. Domain filters reapply locally; missing links are skipped. `includeContent` does nothing here: no body is available and no second billed request is made.

Wrong zone type, missing `organic`, invalid JSON, and provider error envelopes (even HTTP 200) report errors rather than empty success. Billed-response errors identify the zone; HTTP 402/429 classify as quota, 401/403 as auth, unreadable 200 as invalid-response. Quoted upstream status/rate-limit text cannot impersonate local classifications. Tokens are redacted from errors/activity, parser snippets cannot leak key prefixes, and invalid credentials JSON reports file/position without its content. Search has a 60-second timeout and honors cancellation; unreadable 200 falls through only when `invalid-response` is configured.

Unlocker runs after Parallel and before Gemini, validates the target before resolving credentials, validates API redirects, and strips cross-origin authorization. Any non-empty successful body ends fallback, including consent stubs. Like other hosted fetchers it sees target URLs/content from its own network; leave its zone unset for private targets.

Provider terms in upstream's snapshot: 5,000 monthly free SERP credits, reset on the first without carryover; wallet billing requires deposited funds. Custom pay-as-you-go/pre-commit accounts may be ineligible, free credits exclude proxy/Browser API products, and never-funded accounts cap at 1,000 requests/minute. Check [free tier](https://docs.brightdata.com/general/account/billing-and-pricing/free-tier) / [pricing](https://brightdata.com/pricing), not this document, for current entitlement. Queries, filters, and result URLs pass through Bright Data; use controlled infrastructure for private research. Its [security overview](https://docs.brightdata.com/general/security/security-overview) does not establish a retention period for those request data; no zero-retention claim is made here.

### SERPdive

`serpdiveModel` / `SERPDIVE_MODEL` controls depth, independently of whether `includeContent` exposes returned bodies inline:

| Model | Upstream pricing snapshot | Returned data |
| --- | --- | --- |
| `krill` (default; also fallback for unknown model values) | Free/fair use | Extracted content, no API answer synthesis |
| `mako` | 1 credit | Fact-carrying sentences and synthesized answer |
| `moby` | 1.5 credits | Full readable pages and cited answer |

Recency is a query hint, not a guaranteed filter; domains filter returned results locally. `numResults` maps to `max_results`, capped at 10 and never a minimum. Retrieval depth changes only with the model: install/defaults never opt into paid tiers. See [pricing](https://serpdive.com/pricing) and the preserved [2026-07-25 contract evidence](evidence/CONTRACT-EVIDENCE.md).

### Other provider-specific limits

| Provider | Filter/content/auth behavior |
| --- | --- |
| Kagi | Count → `limit`; snippets plus returned Markdown for inline content; Extract follows Querit, before Ollama/Parallel; validates targets and strips cross-origin auth |
| Ollama Cloud | `POST https://ollama.com/api/web_search`, max 10; Web Fetch follows Kagi; local target preflight |
| SerpBase / SerpApi / Serper / Serply | Google `site:` clauses plus local domain filters and Google `tbs` recency; explicit-only; Serply uses `X-Api-Key` |
| Valyu | Returned bodies supply snippets/inline text, capped at 2,500 / 4,000 characters per result |
| Keenable | Keyless per-IP limits or authenticated higher tier; one included domain uses `site`, other filters use query clauses and local filtering; recency → `published_after`; snippets cap 500 |
| Ceramic | Keyword rather than question search; included domains become `site:`, exclusions are local-only and can reduce count; recency unsupported/not sent; snippets cap 500; [keys](https://platform.ceramic.ai/keys) |
| You.com | `X-API-Key`; domain lists → `include_domains` / `exclude_domains`, recency → `freshness`; paid account credits |
| Parallel MCP | Keyless search with optional REST account key as Bearer; hosted `web_fetch` needs explicit `parallel-mcp` fetch routing **and** remote-hosted opt-in |
| Perplexity | Search API snippets, not Sonar-generated answers; Sonar remains the YouTube text-summary fallback |

**Baizhi:** explicit-only commercial Streamable HTTP MCP (`websearch_search`); Bearer key, initialized/closed session per request, redirects rejected, cancellation and body reads share 60 seconds. Queries/filters leave for the hosted service and may spend credits. Domains map to `filter`, recency to `time_range` (default `month`), with generated summaries disabled. Mapping follows the [2026-09-16 discovery snapshot](https://github.com/ct-jaryn/baizhi-agent-toolkit/blob/b774c117369b8da2a1e42c7d01bf9535bb9a41c6/tests/fixtures/tools-history-2026-09-16.json), which has no output schema: MCP text/structured content is kept as the answer, with no guessed source cards or `includeContent` page fetches. Tests used a synthetic backend, not live billing/results; this does not imply the service is open source.

**Z.ai:** explicit-only Coding Plan `webSearchPrime` MCP; `zaiEndpoint` is `global` (default, `api.z.ai`) or `china` (`open.bigmodel.cn`) to match the key's issuing site. No arbitrary endpoint/redirects; Bearer auth only. Recency maps to `search_recency_filter`; `search_domain_filter` supports one included domain (no exclusions), and count is trimmed locally. Calls consume plan quota. No published input/output schema was available; mapping follows established clients and synthetic-backend tests, not a live-contract claim.

**Tavily key pool:** `TAVILY_API_KEY_1`…`TAVILY_API_KEY_20`, starting at `TAVILY_API_KEY_INDEX` (default 1), wrap through each distinct key once on HTTP 401/402/403/429/432, then try ordinary `tavilyApiKey` / `TAVILY_API_KEY`. Explicit env/command sources fail closed instead. All attempts share 60 seconds.

**SearXNG:** `searxngBaseUrl` / `SEARXNG_BASE_URL` enables a self-hosted JSON API, preferred first by auto. Base/redirects are SSRF-checked; private endpoints need narrow allowed ranges. String-only `searxngHeaders` in credentials JSON can carry Zero Trust headers and override `Accept`; invalid header names are ignored. Thanks to @marnunez (PR #107) and @avinashkanaujiya (issue #105).

**degoog:** `degoogBaseUrl` / `DEGOOG_URL` defaults to public `https://degoog.org`; it remains explicit-only, so keyless discovery does not silently send queries there. Optional Bearer key and `degoogHeaders` strip on cross-origin redirects and redact from errors. `degoogEngines` restricts `POST /api/search` engines; recency maps to `time`; domains use grouped `site:` / `-site:` clauses plus local filtering. Only absolute HTTP(S) source URLs survive and deduplicate. Missing `results` is invalid-response; an empty array is successful empty search. A 30-second deadline reports timeout, not completed activity. Self-hosted base/redirects retain SSRF checks.

**DuckDuckGo:** keyless HTML, explicit-only. Domain filtering follows decoded redirects; recency is not guaranteed by the undocumented HTML endpoint. A 200 without parseable results is invalid-response rather than successful emptiness.

**Firecrawl:** `firecrawlBaseUrl` / `FIRECRAWL_BASE_URL` enables search and fetch. Search uses `/v2/search`, `sources: ["web"]`, count → `limit`, recency → `tbs`, and native `includeDomains` / `excludeDomains` where possible. `includeContent` opts into Markdown scrape options. Fetch uses `/v2/scrape`, or `firecrawlApiVersion` / `FIRECRAWL_API_VERSION = v1` for older servers. `firecrawlPdfMaxPages` is a positive **per-document** cap, not a credit budget; v1 plus that cap is invalid. Reported cutoffs name parsed/total page counts. Fresh scraping is disabled (`lockdown: true`) unless `firecrawlFreshScrape = true` or `FIRECRAWL_FRESH_SCRAPE=1`; isolate server-side DNS, redirects, egress, and internal access before opting in.

**Crawl4AI:** `crawl4aiBaseUrl` / `CRAWL4AI_BASE_URL` enables fetch only, after Firecrawl. `POST /md` with `fit` returns top-level `markdown` and first heading as title; 0.9+ normally needs the Bearer token. Targets validate locally but are then disclosed to that server. Only these two configured API endpoints allow localhost/127.0.0.0/8/::1 without a global loopback exception; other private/synthetic ranges need narrow SSRF ranges. This exception never permits private fetch targets, and cross-origin API redirects strip credentials.

### Remote curator access

Default: short-lived server at `127.0.0.1`, printed URL `http://localhost:<port>/?session=<token>`. Opt in only when your browser must reach a remote Pi host:

```toml
[webAccess.curatorRemote]
host = "my-box.tailnet.ts.net"
bind = "100.101.102.103"
```

| `curatorRemote` | URL host | Bind |
| --- | --- | --- |
| Absent / `false` / invalid type | `localhost` | `127.0.0.1` |
| `true` | `os.hostname()` | `0.0.0.0` |
| Only `host` | Supplied host | `0.0.0.0` |
| Only `bind` | `os.hostname()` | Supplied bind |
| Both | Supplied host | Supplied bind |

`host` changes only the printed URL; `bind` determines exposure. Use a matching private interface, not all interfaces. Access control is only the unguessable URL token over **plain HTTP without TLS**: observers can read it/content, and anyone reaching the server with it can spend provider credits and alter summary text sent to the agent. Treat the URL as secret and use a trusted network/tunnel. The server lasts only for curation, not as a hardened authenticated service.

Remote mode prints the URL and defaults idle timeout to 60 seconds; explicit `curatorTimeoutSeconds` or `autoOpenBrowser = true` overrides those defaults.

#### Disabling browser auto-open

`autoOpenBrowser = false` always prints a requested curator URL without launching Glimpse/browser; the local default is `true`.
Remote curator sessions print the URL instead of trying to open a browser by default; set `autoOpenBrowser = true` to opt in. This never changes bind/exposure.
If launch fails in Docker, WSL, SSH, or headless environments, the curator stays running and prints its URL.
Copy it into a browser that can reach the Pi host, using a port-forward if needed.

### Tool activation

The standalone Pi extension can start with compact `web_enable`, then register enabled operations for the next model request. Disabled operations stay absent and alternate names are preserved. Adding tools may invalidate a model's prompt-cache prefix for that request; later requests can cache again.

`toolActivation` defaults to `auto`: new sessions use dynamic activation only if the initially selected model accepts added tools; otherwise tools are eager. `dynamic` forces `web_enable` despite possible cache cost; `eager` exposes enabled tools immediately. The choice is made once: switching models or restoring a session does not rewrite its recorded tool selection. A resumed session without `web_enable` does not acquire it after upgrade; start a new session. Restart after changing activation/registration preferences. Activation follows the native Pi APIs; Metis exposes the deferred grouped `web_access` entrypoint.

### Shortcuts

```toml
[webAccess.shortcuts]
curate = "ctrl+shift+s"
activity = "ctrl+shift+w"
```

Values use Pi keybinding syntax (`ctrl+s`, `alt+r`, etc.); restart to apply.

### Registration gates

Feature gates are `tools.{webSearch,sourceCheck,fetchContent,getSearchContent}.enabled`, `commands.{websearch,curator,search,google-account}.enabled`, `image.enabled`, and `pdf.enabled`. For example:

```toml
[webAccess.tools.webSearch]
enabled = false

[webAccess.commands.websearch]
enabled = false
```

Tool-specific gates override legacy `webSearch.enabled`. Pi restart is required for tool and command registration changes.
`image.enabled = false` blocks direct images, frames, and thumbnails; `pdf.enabled = false` blocks PDF extraction.
GitHub gates only skip specialization as described above. `youtube.enabled` / `video.enabled` control their analysis paths.

## Limitations

- Provider prices/quotas in this guide are upstream snapshots, not freshly measured entitlements or billing guarantees. Explicit selection is required for the marked paid/quota-sensitive providers; review account terms before use.
- Browser-cookie extraction is opt-in and platform/profile-dependent; Windows app-bound cookies are unsupported. Only local `unpdf` lacks OCR; Datalab/Gemini have their own privacy, quality, and page limits.
- Model-derived answers/transcripts may omit material. Use stored sources for verification, and do not treat `source_check` retrieval as semantic proof.
- GitHub slash-containing branches, PR thread resolution state, REST checks, private videos, and long video analysis retain the caveats under their capability sections.
- Core owners: `index.ts` registers the extension; `gemini-search.ts` owns search routing; `extract.ts` owns source/fallback routing; `storage.ts` owns retention; `curator-server.ts` / `curator-page.ts` own review; `summary-review.ts` owns summary policy. Individual provider modules hold transport-specific behavior. Delivery and update checks belong in [METIS.md](METIS.md), not a duplicated file inventory.
