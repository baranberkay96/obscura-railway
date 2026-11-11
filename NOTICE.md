# NOTICE: Obscura Headless Browser for AI Agents (CDP) template

## Software in the image

| Component | Version | Source | Licence | How it is used |
|---|---|---|---|---|
| Obscura | 0.2.6 (tag `v0.2.6`, released 2026-10-31) | https://github.com/h4ckf0r0day/obscura release archives `obscura-{x86_64,aarch64}-linux-stealth.tar.gz`, SHA-256 `ac805737…edc08c5` (x86_64) and `403b4c8e…fc3811f` (aarch64) | Apache-2.0. The licence text (tag `v0.2.6`, SHA-256 `50e67517…b0c780a`) is installed in `/usr/local/share/doc/obscura/LICENSE`. The binary embeds Liberation fonts (SIL OFL 1.1), DejaVu fonts (Bitstream Vera licence) and Noto Color Emoji (SIL OFL 1.1), as listed in the upstream `crates/obscura-render/assets/FONT-PROVENANCE.md`. | Unmodified `obscura` and `obscura-worker` binaries, run as `obscura serve` |
| Node.js | 24.22.3 LTS | https://nodejs.org/dist/v24.22.3/ `node-v24.22.3-linux-{x64,arm64}.tar.xz`, SHA-256 `4f2b175a…44e66fcfb` (x64) and `6e51a2ad…1ce6e86c` (arm64) | MIT, with the bundled third-party licences in `/usr/local/share/doc/nodejs/LICENSE` | Unmodified `node` binary that runs the gate (npm and headers are not installed) |
| Debian 13 (trixie) base | `debian:trixie-20261104-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2` | Docker Hub official image | Various (Debian archive; per-package copyright files in `/usr/share/doc`) | Base OS, including glibc and libgcc_s, the only libraries Obscura links against |
| tini | 0.19.0 | Debian archive | MIT | Init/subreaper in front of the gate |
| ca-certificates | 20250419 | Debian archive | MPL-2.0 (Mozilla CA list), GPL-2.0+ (scripts) | HTTPS trust store for the default transport (stealth mode uses Obscura's bundled webpki roots) |

Debian packages are installed unmodified from the archive. Their exact versions follow the pinned base image's release (trixie) and are not pinned individually.

## Written for this template

All files in this package were written for this template: `services/obscura/Dockerfile`, the `obscura-gate` sources and tests in `services/obscura/gate/`, and `template.json`, `TEMPLATE.md`, `README.md` and this file. The gate is adapted from the gate we wrote for our Moli template (same author, same structure); no code or text was copied from Obscura, from the market templates or from other authors' templates. The gate's test double (`gate/test/fake-obscura.js`) reimplements the observable HTTP behaviour of Obscura's CDP server (Host, Origin and bearer-token checks, discovery JSON shape); it contains no Obscura source code.

The icon is Obscura's own `assets/icon.png` from the upstream repository at tag `v0.2.6`, referenced by URL on jsDelivr. It identifies the software the template deploys.

## Upstream sources and docs checked (2026-11-11)

- `gh release view v0.2.6 -R h4ckf0r0day/obscura`: assets and release notes. Both Linux `-stealth` archives downloaded and hashed locally; each contains only `obscura` and `obscura-worker`.
- ELF headers of the x86_64 binary read (not executed): `NEEDED` ld-linux-x86-64.so.2, libc.so.6, libgcc_s.so.1; highest symbol version GLIBC_2.35. The embedded version string is `v0.2.6`.
- Source tarball of tag `v0.2.6` (read only): `README.md`, `Dockerfile`, `docs/{Environment-variables,Run-in-production-at-scale,Connect-Puppeteer-or-Playwright,Configure-stealth-and-proxies}.md`, `crates/obscura-cli/src/main.rs` (serve flags and defaults, global `--stealth`, `--allow-private-network`, `--proxy`, `--workers`, `--max-connections` default 128), `crates/obscura-cdp/src/server.rs` (`control_refusal`: any `Origin` refused, `Host` must match the bind address and port, bearer token of at least 32 bytes; `/json/version` and `/json/list` build `ws://{Host}/devtools/...`; any WebSocket path reaches the browser), `crates/obscura-net/src/client.rs` (private-network deny list incl. CGNAT, unique-local and metadata), `crates/obscura-render/src/inline.rs` (bundled fonts only, no system font lookup), `crates/obscura-mcp/src/http.rs` (MCP transport, not used here).
- Docker Hub `h4ckf0r0day/obscura` tags (official image is the non-stealth build on distroless).
- nodejs.org `dist/index.json` and `dist/v24.22.3/SHASUMS256.txt`.
- Docker Hub `library/debian` tags for `trixie-20261104-slim`.

## Market templates reviewed

| Template | Source | Use |
|---|---|---|
| `obscura-aug-26-headless-browser` ("Obscura") | builds `h4ckf0r0day/obscura` from source with the upstream Dockerfile | Read for comparison only. Nothing copied. |
| `template-obscura` | builds `lifeofjer/obscura` | Read for comparison only (its README; the repository was not opened). Nothing copied. |

## Names and affiliation

Obscura is a name of its respective owners. This is a community template; it is not affiliated with, sponsored or endorsed by the Obscura authors or Railway. Users are responsible for complying with the terms of the sites they automate and with Railway's Fair Use Policy.
