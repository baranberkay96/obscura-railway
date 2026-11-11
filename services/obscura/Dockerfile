# syntax=docker/dockerfile:1
#
# Obscura headless browser for Railway, behind a token gate.
#   - Obscura 0.2.6 (h4ckf0r0day, Apache-2.0): prebuilt "-stealth" release
#     archive (rendering + stealth transport), SHA-256 pinned. Stealth stays
#     off unless OBSCURA_STEALTH=true. `obscura serve` listens on
#     127.0.0.1:9222 only and requires an internal token the gate generates.
#   - obscura-gate (this repo, Node.js standard library only): the public
#     listener on $PORT. Checks the public token, rewrites CDP discovery URLs
#     to the public address, limits and times out sessions, and supervises
#     Obscura.
#   - Node.js LTS: official nodejs.org tarball, SHA-256 pinned (binary only).
# Obscura embeds its own fonts (Liberation, DejaVu, Noto Color Emoji) and
# does not read system fonts, so none are installed. No volume: every CDP
# connection starts with a clean browser context.
#
# Base image pinned by dated tag and digest (Docker Hub library/debian,
# trixie-20261104-slim, checked 2026-11-11). Obscura's Linux build needs
# glibc >= 2.35 (built on Ubuntu 22.04); trixie ships 2.41.
FROM debian:trixie-20261104-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2

# Pinned versions. Bump deliberately; checksums must match the new release.
# (PIN_ prefix keeps build args from colliding with OBSCURA_* variables.)
ARG PIN_OBSCURA=0.2.6
ARG PIN_OBSCURA_SHA256_AMD64=ac8057374ec1b5cabb78ea2d08b2ed890d21d156a42b1ac23357fd049edc08c5
ARG PIN_OBSCURA_SHA256_ARM64=403b4c8e3bcf777748a870fbb32c9281e997a6c30c5f8377c17305287fc3811f
ARG PIN_OBSCURA_LICENSE_SHA256=50e6751797c50dedd75ef1b8a0d9e42f5f8472e9fbce91f34718e9f97b0c780a
ARG PIN_NODE=24.22.3
ARG PIN_NODE_SHA256_AMD64=4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb
ARG PIN_NODE_SHA256_ARM64=6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=UTC

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Runtime: CA certificates for HTTPS and tini. Obscura links only against
# glibc and libgcc_s, both in the base image. Debian archive packages, not
# version-pinned: the base image digest fixes the release.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

# Obscura and Node.js release downloads, checksum-verified. curl and xz are
# only needed here and are removed again. Every download retries: a dropped
# connection would fail the whole build.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl xz-utils \
 && case "$(dpkg --print-architecture)" in \
      amd64) obscura_arch=x86_64;  obscura_sha="${PIN_OBSCURA_SHA256_AMD64}"; node_arch=x64;   node_sha="${PIN_NODE_SHA256_AMD64}" ;; \
      arm64) obscura_arch=aarch64; obscura_sha="${PIN_OBSCURA_SHA256_ARM64}"; node_arch=arm64; node_sha="${PIN_NODE_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac \
 && curl -fsSL --retry 5 --retry-all-errors -o /tmp/obscura.tar.gz \
      "https://github.com/h4ckf0r0day/obscura/releases/download/v${PIN_OBSCURA}/obscura-${obscura_arch}-linux-stealth.tar.gz" \
 && echo "${obscura_sha}  /tmp/obscura.tar.gz" | sha256sum -c - \
 && install -d -m 0755 /tmp/obscura \
 && tar -xzf /tmp/obscura.tar.gz -C /tmp/obscura --no-same-owner obscura obscura-worker \
 && install -m 0755 /tmp/obscura/obscura /tmp/obscura/obscura-worker /usr/local/bin/ \
 && install -d -m 0755 /usr/local/share/doc/obscura \
 && curl -fsSL --retry 5 --retry-all-errors -o /usr/local/share/doc/obscura/LICENSE \
      "https://raw.githubusercontent.com/h4ckf0r0day/obscura/v${PIN_OBSCURA}/LICENSE" \
 && echo "${PIN_OBSCURA_LICENSE_SHA256}  /usr/local/share/doc/obscura/LICENSE" | sha256sum -c - \
 && chmod 0644 /usr/local/share/doc/obscura/LICENSE \
 && rm -rf /tmp/obscura.tar.gz /tmp/obscura \
 && curl -fsSL --retry 5 --retry-all-errors -o /tmp/node.tar.xz \
      "https://nodejs.org/dist/v${PIN_NODE}/node-v${PIN_NODE}-linux-${node_arch}.tar.xz" \
 && echo "${node_sha}  /tmp/node.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/node.tar.xz -C /tmp --no-same-owner \
      "node-v${PIN_NODE}-linux-${node_arch}/bin/node" "node-v${PIN_NODE}-linux-${node_arch}/LICENSE" \
 && install -m 0755 "/tmp/node-v${PIN_NODE}-linux-${node_arch}/bin/node" /usr/local/bin/node \
 && install -d -m 0755 /usr/local/share/doc/nodejs \
 && install -m 0644 "/tmp/node-v${PIN_NODE}-linux-${node_arch}/LICENSE" /usr/local/share/doc/nodejs/LICENSE \
 && rm -rf /tmp/node.tar.xz "/tmp/node-v${PIN_NODE}-linux-${node_arch}" \
 && apt-get purge -y --auto-remove curl xz-utils \
 && rm -rf /var/lib/apt/lists/* \
 && obscura --version | grep -F "${PIN_OBSCURA}" \
 && node --version | grep -Fx "v${PIN_NODE}"

# Unprivileged runtime user; nothing in this image needs root at run time.
# Obscura runs untrusted page JavaScript in V8, so a V8 exploit lands without
# root as well.
RUN groupadd --system --gid 10001 obscura \
 && useradd --system --uid 10001 --gid 10001 --home-dir /home/obscura --create-home --shell /usr/sbin/nologin obscura

# The gate. COPY without --chmod: the new directories stay 0755.
COPY gate/package.json /opt/obscura-gate/package.json
COPY gate/src/ /opt/obscura-gate/src/
RUN chmod -R a+rX,go-w /opt/obscura-gate \
 && node /opt/obscura-gate/src/selftest.js

ENV PORT=8080 \
    HOME=/home/obscura \
    NO_COLOR=1 \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

USER 10001:10001
WORKDIR /home/obscura
EXPOSE 8080

# Railway runs its own init as PID 1, so tini runs as a subreaper (-s).
# The gate (node) listens on $PORT, starts `obscura serve` on loopback and
# restarts it if it exits; SIGTERM stops both.
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/usr/local/bin/node", "/opt/obscura-gate/src/main.js"]
