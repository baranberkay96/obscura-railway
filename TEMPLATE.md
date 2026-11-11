# Obscura Headless Browser for AI Agents (CDP): Railway template spec

## Listing

| Field | Value |
|---|---|
| Name | **Obscura Headless Browser for AI Agents (CDP)** (44 chars; no version label, because Obscura is a fast-moving 0.x release) |
| Description | Token-protected Rust headless browser with stealth mode, for Playwright. (72 chars) |
| Category | Automation (next to Railway's Browserless templates, which share the audience) |
| Tags | obscura, headless-browser, cdp, playwright, puppeteer, stealth, browser-automation, ai-agents, web-scraping, browserless |
| Icon | `https://cdn.jsdelivr.net/gh/h4ckf0r0day/obscura@v0.2.6/assets/icon.png` (200, image/png) |
| Repo | `baranberkay96/obscura-railway`, service root `/services/obscura` |

## Base market templates

Two market templates exist (checked 2026-11-11):

- `obscura-aug-26-headless-browser` ("Obscura", 3 projects, created 2026-08-20). One service built from the upstream repository `h4ckf0r0day/obscura` with its own Dockerfile, so every deploy compiles Obscura and V8 from the moving default branch. No variables are set. The upstream image binds `0.0.0.0`, and since the CDP token became mandatory for non-loopback binds, Obscura refuses to start without `OBSCURA_CDP_TOKEN`. Clients would also need the token as a header and get `ws://` discovery URLs with the wrong host.
- `template-obscura` (0 projects, created 2026-11-11). Builds a fork with the non-stealth release binary and a token, private network only (no public domain).

This package differs as follows:

- Prebuilt, checksum-pinned `-stealth` release archive (rendering plus stealth transport): builds in about a minute, never compiles V8, and stealth is one variable away.
- Public HTTPS domain with a gate in front: Browserless-style `wss://{domain}?token=...`, Bearer and Basic auth, discovery rewritten to `wss://{domain}/devtools/...?token=...`, Origin check, session limit, idle and lifetime timeouts.
- Obscura stays on 127.0.0.1 and gets a random internal token that never leaves the container, so the public token can be rotated and is never forwarded.
- Private-network guard on by default, as upstream, with one variable to turn it off.

## Pinned versions

| Component | Source | Version | Released | Checked |
|---|---|---|---|---|
| Obscura | GitHub release `h4ckf0r0day/obscura` `v0.2.6`, `obscura-{x86_64,aarch64}-linux-stealth.tar.gz` | 0.2.6 | 2026-10-31 | 2026-11-11 |
| Node.js | nodejs.org `node-v24.22.3-linux-{x64,arm64}.tar.xz` (binary and LICENSE only) | 24.22.3 LTS "Krypton" | 2026-11-10 | 2026-11-11 |
| Base image | `debian:trixie-20261104-slim@sha256:a72b4433…0d63b6b2` (multi-arch index) | Debian 13 | 2026-11-05 | 2026-11-11 |
| Debian packages | ca-certificates, tini 0.19.0 | trixie stable | — | 2026-11-11 |

SHA-256 (each file downloaded and hashed locally):

- Obscura x86_64 stealth: `ac8057374ec1b5cabb78ea2d08b2ed890d21d156a42b1ac23357fd049edc08c5`
- Obscura aarch64 stealth: `403b4c8e3bcf777748a870fbb32c9281e997a6c30c5f8377c17305287fc3811f`
- Obscura LICENSE at `v0.2.6`: `50e6751797c50dedd75ef1b8a0d9e42f5f8472e9fbce91f34718e9f97b0c780a`
- Node.js x64: `4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb`
- Node.js arm64: `6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c`

All pins are `PIN_*` build args at the top of `services/obscura/Dockerfile`. Release archives stay downloadable, unlike vendor apt pins (STANDARD lesson 27).

## Architecture

```
Client (Playwright connectOverCDP, Puppeteer, chromedp, browser-use)
  │  wss://{domain}?token=…  |  https://{domain}/json/version?token=…
  ▼
Railway edge (TLS) ──► :8080 obscura-gate (Node.js, [::], user 10001)
                          │ /health, /robots.txt         public
                          │ Origin check → token check   (?token= | Bearer | Basic)
                          │ strips token and Origin; Host → 127.0.0.1:9222;
                          │ Authorization → Bearer {internal token}
                          │ HTTP: only /json, /json/list, /json/version, /json/protocol
                          │ rewrites ws://127.0.0.1:9222/… in discovery JSON
                          │ WebSocket: / → /devtools/browser, session limit, timeouts, byte pipe
                          ▼
                      127.0.0.1:9222 obscura serve [--stealth] [--workers N] [--allow-private-network]
                          (child of the gate, env OBSCURA_CDP_TOKEN={internal}; restarted with backoff)
tini -s (subreaper) ─► node /opt/obscura-gate/src/main.js ─► obscura serve
```

**Why a gate instead of exposing Obscura.** Obscura 0.2.6 checks that `Host` names its bind address and port (`control_refusal` in `crates/obscura-cdp/src/server.rs`). Railway's edge sends the public domain without a port, so a direct bind can only match on port 80, and the healthcheck could never pass, because every path including `/json/version` needs the bearer token. Obscura also refuses any request with an `Origin` header, accepts the token only as a header (not in the URL), and advertises `ws://{Host}/devtools/browser`, which is wrong behind TLS. The gate (Node standard library only, 58 tests, adapted from our Moli gate) fixes all four.

## Services

### Obscura

| Setting | Value |
|---|---|
| Source | repo `baranberkay96/obscura-railway`, root `/services/obscura` (Dockerfile) |
| Start command | none (image entrypoint) |
| Healthcheck | `/health` on `PORT=8080`, timeout 180 s. 200 only when Obscura is running and answers `/json/version` with the internal token. |
| Public domain | yes, target port 8080 |
| TCP proxy | none |
| Volume | none (no state to keep) |
| Restart policy | ALWAYS (no max retries) |
| Replicas | 1 (each replica is a separate browser) |

Files in `services/obscura/`: `Dockerfile`, `gate/package.json`, `gate/src/*.js` (gate), `gate/test/*.js` (tests, not copied into the image).

### Variables

| Variable | Default | Notes |
|---|---|---|
| `OBSCURA_TOKEN` | `secret(48, A-Za-z0-9)` | Required. Public access token. |
| `PORT` | 8080 | Gate port, healthcheck and domain target. |
| `OBSCURA_STEALTH` | false | `--stealth`: browser-matching TLS, consistent profile, tracker blocklist. |
| `OBSCURA_WORKERS` | 1 | `--workers N` (1–32). |
| `OBSCURA_BLOCK_PRIVATE_NETWORKS` | true | false adds `--allow-private-network`. |
| `OBSCURA_MAX_SESSIONS` | 10 | Gate limit on open WebSockets (0 = unlimited). |
| `OBSCURA_IDLE_TIMEOUT` | 1800 | Seconds without traffic before a WebSocket is closed. |
| `OBSCURA_SESSION_TIMEOUT` | 0 | Maximum WebSocket lifetime in seconds (0 = off). |
| `OBSCURA_PROXY` | empty | Obscura's own variable: outbound HTTP/SOCKS5 proxy. |
| `OBSCURA_LOG_LEVEL` | warn | `RUST_LOG` for Obscura. |
| `OBSCURA_EXTRA_ARGS` | empty | More `obscura serve` flags; `--host`, `--port`, `-p`, `--ready-file` refused. |
| `BROWSER_TOKEN`, `BROWSER_WS_ENDPOINT`, `BROWSER_WS_ENDPOINT_PRIVATE` | references | Browserless-compatible names for client services. |

Not in the template but supported: `OBSCURA_ALLOWED_ORIGINS`, `OBSCURA_HTTP_TIMEOUT`, `OBSCURA_GATE_LOG_LEVEL`, and every other `OBSCURA_*` variable from Obscura's documentation, which the gate passes through (except the CDP/MCP token, origin and private-network variables, which the gate owns).

## Resource profile

Measured on the first deploy test (to be filled in).

## Verification checklist

1. Build succeeds; the build log shows `obscura-gate self-test ok`, `obscura … 0.2.6` and `v24.22.3`.
2. `/health` returns 200; `/json/version` without a token returns 401; with `?token=` it returns `wss://{domain}/devtools/browser?token=…`.
3. A CDP client connects to `wss://{domain}?token=…`, opens a page, navigates to https://example.com, reads the title, takes a screenshot.
4. Same through `/json/version` discovery and with `Authorization: Bearer`.
5. A page cannot load `http://{other-service}.railway.internal` or `http://169.254.169.254/` with the default setting.
6. `OBSCURA_STEALTH=true` redeploy: same client works; the gate's `/` info shows `stealth: true`.
7. Memory at idle and during a navigation, and on a 0.5 GB limit (Free plan).
8. Redeploy keeps working (no state).

## Open questions

- Obscura is a young engine; site compatibility differs from Chromium (documented in the README).
- `OBSCURA_WORKERS` > 1 was checked in the source, not on Railway.
