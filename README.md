# Deploy and Host Obscura with Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/obscura-headless-browser-for-ai-agents-c?referralCode=20H68q)

Obscura is an open-source headless browser for AI agents and web scraping, written in Rust. It runs real JavaScript in V8, speaks the Chrome DevTools Protocol (CDP), and works with Playwright and Puppeteer like a remote Chrome. It also renders screenshots and PDFs itself, without Chromium. This template runs Obscura 0.2.6 always on, behind a token, with optional stealth mode.

## About Hosting Obscura

Obscura's CDP server has no user accounts, and an exposed browser is a free proxy for anyone who finds it. This community template keeps Obscura on loopback and puts a small gate on the Railway domain. The gate requires a token generated at deploy on every request and WebSocket. It accepts the token Browserless-style in the URL and rewrites CDP discovery so clients get your public `wss://` address. It also caps open sessions, closes idle ones and restarts Obscura if it exits. Pages cannot reach your Railway private network by default. One service, no database, no volume.

## Common Use Cases

- A remote browser for AI agents (browser-use, Stagehand, LangChain tools, your own Playwright or Puppeteer code) without running Chrome locally
- Scraping and extraction of JavaScript-rendered pages: text, HTML, Markdown (`LP.getMarkdown`), screenshots and PDFs
- Sites that block plain HTTP clients by TLS fingerprint, with stealth mode and your own proxy
- A drop-in for code that reads `BROWSER_WS_ENDPOINT` from a Browserless service, for CDP clients

## Dependencies for Obscura Hosting

- Obscura 0.2.6, the official Linux release binary with rendering and stealth support, checksum-verified (included)
- A token gate built from this repository on Node.js 24 LTS (included)
- A CDP client: Playwright (`connectOverCDP`), Puppeteer, chromedp or raw WebSockets

### Deployment Dependencies

- Obscura source, docs and releases: https://github.com/h4ckf0r0day/obscura
- Playwright `connectOverCDP`: https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp
- Puppeteer `connect`: https://pptr.dev/api/puppeteer.puppeteer.connect
- Railway private networking: https://docs.railway.com/guides/private-networking
- Railway Fair Use Policy: https://railway.com/legal/fair-use

### Implementation Details

| Service | Source | Purpose |
|---|---|---|
| Obscura | Dockerfile in `services/obscura` (Debian trixie slim, Obscura 0.2.6, Node.js 24.22.3) | Gate on `PORT` 8080 (public domain, `/health` healthcheck); `obscura serve` on 127.0.0.1:9222 |

**Connect.** Copy `BROWSER_WS_ENDPOINT` from the service's Variables tab. It looks like `wss://{your-domain}?token={OBSCURA_TOKEN}`. From another service in the same project, reference `${{Obscura.BROWSER_WS_ENDPOINT_PRIVATE}}`: it uses the private network, which is faster and adds no egress.

Playwright (Node.js). Use `connectOverCDP`; Playwright's `connect` speaks a different protocol. Use one context per job, because contexts keep cookies and storage apart:

```js
import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP(process.env.BROWSER_WS_ENDPOINT);
const context = await browser.newContext();
const page = await context.newPage();
await page.goto("https://example.com");
console.log(await page.title());
await context.close();
await browser.close();
```

Playwright (Python) works the same way: `await p.chromium.connect_over_cdp(os.environ["BROWSER_WS_ENDPOINT"])`. To keep the token out of the URL, pass `headers={"Authorization": "Bearer {OBSCURA_TOKEN}"}` and connect to `wss://{your-domain}`.

Puppeteer:

```js
import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({ browserWSEndpoint: process.env.BROWSER_WS_ENDPOINT });
```

Other CDP tools: pass the same `wss://` URL. Prefer it over the `https://` form for clients that append paths to the URL you give them.

**Authentication.** Every path except `/health` and `/robots.txt` needs `OBSCURA_TOKEN`, sent as `?token=`, as `Authorization: Bearer`, or as the Basic auth password (any user name). The gate removes it before the request reaches Obscura, which only accepts a second, random token that never leaves the container. Requests from a browser page on another site are refused; list trusted origins in `OBSCURA_ALLOWED_ORIGINS` if you need that. To rotate the token, change `OBSCURA_TOKEN` and redeploy. `/json/version` and `/json/list` include the token in their URLs, so treat their output like the token itself.

**Stealth.** `OBSCURA_STEALTH=true` switches page traffic to a browser-matching TLS fingerprint, keeps the browser profile consistent and blocks about 3,500 tracker domains. It helps against basic bot detection. It does not solve CAPTCHAs, Cloudflare interactive challenges or IP-based limits; add your own proxy with `OBSCURA_PROXY` (HTTP or SOCKS5). Obscura reports the `Europe/Berlin` timezone by default. Set `OBSCURA_TIMEZONE` and `OBSCURA_GEOLOCATION` to match your exit IP. `OBSCURA_EXTRA_ARGS` passes more flags to `obscura serve`, such as `--user-agent "MyAgent/1.0"` or `--obey-robots`. Other `OBSCURA_*` variables from Obscura's documentation (timeouts, resource limits, profiles) are passed through unchanged.

**Limits.** `OBSCURA_MAX_SESSIONS` (default 10) caps open CDP connections; extra ones get HTTP 429. `OBSCURA_IDLE_TIMEOUT` (default 1800 s) closes connections with no traffic. `OBSCURA_SESSION_TIMEOUT` (default off) caps a connection's lifetime. One connection can hold many pages.

**Private networks.** `OBSCURA_BLOCK_PRIVATE_NETWORKS=true` (default) keeps Obscura's built-in guard on: pages cannot reach private, loopback, link-local or unique-local addresses, including `*.railway.internal` and cloud metadata. Set it to `false` only to browse your own internal services.

**Scaling and cost.** Keep one replica: each replica is a separate browser. For more throughput raise `OBSCURA_WORKERS`, which spreads connections over several Obscura processes, and give the service more CPU and memory. Measured on Railway: about 0.11 GB of RAM idle (Obscura plus the gate) and at most 0.33 GB with 10 parallel connections loading Wikipedia, Hacker News and example.com, also under a 0.5 GB limit with stealth on. So every plan works, including Free. Responses sent over the public domain count as egress.

**Persistence.** None: cookies and site storage live in each browser context and reset when Obscura restarts. Log in from your script or set cookies per run.

**Pinning and upgrades.** Obscura and Node.js versions and their SHA-256 checksums are build arguments at the top of `services/obscura/Dockerfile`. Change them to a newer release and redeploy. Obscura is young and releases every few weeks; read its release notes before upgrading.

**Compatibility.** Obscura is its own engine, not Chromium. Most automation works, but long-tail CSS, some Web APIs, WebGL and media playback differ from Chrome, and screenshots use Obscura's bundled fonts (Latin, Cyrillic, Greek, emoji). Unsupported protocol calls return explicit errors.

**Fair use.** Respect the terms of service and robots.txt of the sites you visit, keep request rates reasonable, and do not use this browser for abuse, spam, credential stuffing or to get around access controls. Railway's Fair Use Policy applies to your deployment. This is a community template, not affiliated with or endorsed by the Obscura authors.

### Why Deploy Obscura on Railway?

Railway gives Obscura an HTTPS domain, private networking to your other services and usage-based billing, with nothing to administer. Your agents get a light, always-on browser protected by a token, and it costs little while it waits.
