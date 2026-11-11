#!/usr/bin/env node
// Test double for `obscura serve`. It reproduces the parts of Obscura 0.2.6's
// CDP server that the gate depends on (crates/obscura-cdp/src/server.rs):
//   - control_refusal: any Origin -> 403; Host must name the loopback bind
//     address and port -> 403; Authorization must be "Bearer
//     <OBSCURA_CDP_TOKEN>" -> 401
//   - /json/version and /json/list with ws://{Host}/devtools/... URLs
//   - WebSocket upgrade on any path (text echo)
// Every request is recorded for assertions.
// Run directly (`fake-obscura.js serve --host 127.0.0.1 --port 9222 ...`) it
// acts as the Obscura binary for supervisor tests; the token then comes from
// OBSCURA_CDP_TOKEN, as in Obscura.

import http from 'node:http';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function hostMatchesBind(host, port) {
  if (typeof host !== 'string') return false;
  let url;
  try {
    url = new URL(`http://${host}/`);
  } catch {
    return false;
  }
  const urlPort = url.port === '' ? 80 : Number(url.port);
  const name = url.hostname;
  return urlPort === port && (name === 'localhost' || /^127\.\d+\.\d+\.\d+$/.test(name));
}

// Minimal server side of RFC 6455 for small text frames: unmask and echo.
function echoFrames(socket) {
  let buffer = Buffer.alloc(0);
  socket.on('end', () => socket.end());
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      }
      const masked = (buffer[1] & 0x80) !== 0;
      const total = offset + (masked ? 4 : 0) + length;
      if (buffer.length < total) return;
      const mask = masked ? buffer.subarray(offset, offset + 4) : null;
      const payload = Buffer.from(buffer.subarray(total - length, total));
      if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      buffer = buffer.subarray(total);
      if (opcode === 0x8) {
        socket.end(Buffer.from([0x88, 0x00]));
        return;
      }
      const header =
        payload.length < 126
          ? Buffer.from([0x80 | opcode, payload.length])
          : Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 0xff]);
      socket.write(Buffer.concat([header, payload]));
    }
  });
}

/**
 * @param {{ token: string|null }} options token Obscura expects (null = no auth)
 */
export function createFakeObscura({ token }) {
  const requests = [];
  const upgraded = new Set();
  const state = { port: 0, slowMs: 0 };

  const refusal = (req) => {
    if (req.headers.origin !== undefined) return [403, 'request refused'];
    if (!hostMatchesBind(req.headers.host, state.port)) return [403, 'request refused'];
    if (token !== null && req.headers.authorization !== `Bearer ${token}`) return [401, 'authentication required'];
    return null;
  };

  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: { ...req.headers } });
    const refused = refusal(req);
    if (refused) return json(res, refused[0], { error: refused[1] });
    const authority = req.headers.host;
    const respond = () => {
      if (req.url.includes('/json/version')) {
        return json(res, 200, {
          Browser: 'Chrome/145.0.0.0',
          'Protocol-Version': '1.3',
          webSocketDebuggerUrl: `ws://${authority}/devtools/browser`,
        });
      }
      if (req.url.includes('/json/list') || /^\/json\/?(\?|$)/.test(req.url)) {
        return json(res, 200, [
          {
            description: '',
            devtoolsFrontendUrl: '',
            id: 'page-1',
            type: 'page',
            url: 'about:blank',
            webSocketDebuggerUrl: `ws://${authority}/devtools/page/page-1`,
          },
        ]);
      }
      if (req.url.includes('/json/protocol')) return json(res, 200, { version: { major: '1', minor: '3' } });
      // Obscura treats any other GET as a WebSocket handshake and drops it.
      res.socket.destroy();
      return undefined;
    };
    if (state.slowMs > 0) setTimeout(respond, state.slowMs);
    else respond();
    return undefined;
  });

  server.on('upgrade', (req, socket) => {
    requests.push({ method: req.method, url: req.url, headers: { ...req.headers }, upgrade: true });
    const refused = refusal(req);
    if (refused) {
      socket.end(`HTTP/1.1 ${refused[0]} Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      return;
    }
    upgraded.add(socket);
    socket.on('close', () => upgraded.delete(socket));
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}${WS_GUID}`).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    echoFrames(socket);
  });

  return {
    requests,
    server,
    set slowMs(value) {
      state.slowMs = value;
    },
    async listen(port = 0, host = '127.0.0.1') {
      await new Promise((resolve) => server.listen(port, host, resolve));
      state.port = server.address().port;
      return state.port;
    },
    close() {
      for (const socket of upgraded) socket.destroy();
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function parseServeArgs(argv) {
  const value = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index === -1 ? fallback : argv[index + 1];
  };
  return { host: value('--host', '127.0.0.1'), port: Number(value('--port', '9222')) };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  if (argv[0] !== 'serve') {
    process.stderr.write('error: unexpected subcommand\n');
    process.exit(2);
  }
  if (argv.includes('--fail-fast')) {
    process.stderr.write("error: unexpected argument '--fail-fast' found\n");
    process.exit(2);
  }
  const token = process.env.OBSCURA_CDP_TOKEN ?? '';
  if (token !== '' && token.length < 32) {
    process.stderr.write('Error: OBSCURA_CDP_TOKEN must be at least 32 bytes\n');
    process.exit(1);
  }
  const { host, port } = parseServeArgs(argv);
  const fake = createFakeObscura({ token: token === '' ? null : token });
  fake.listen(port, host).then(() => {
    const envKeys = Object.keys(process.env).filter((k) => k.startsWith('OBSCURA_')).sort().join(',');
    process.stdout.write(`fake obscura listening on ${host}:${port} args=${argv.join(' ')} env=${envKeys}\n`);
  });
  process.on('SIGTERM', () => process.exit(0));
}
