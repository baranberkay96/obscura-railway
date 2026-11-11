// Plain HTTP proxying to Obscura: CDP discovery (/json/version, /json/list,
// /json/protocol). Discovery responses are buffered and rewritten
// (rewrite.js); anything else streams through.

import http from 'node:http';
import { downstreamResponseHeaders, upstreamRequestHeaders } from './headers.js';
import { MAX_REWRITE_BYTES, rewriteBody, shouldRewrite } from './rewrite.js';
import { upstreamAuthorization, upstreamHostHeader } from './upstream.js';

/**
 * Sends a small JSON response.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {object} body
 * @param {Record<string, string>} headers
 */
export function sendJson(res, status, body, headers = {}) {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function bufferAndRewrite(upstreamRes, res, rewriteContext) {
  const chunks = [];
  let size = 0;
  let overflow = false;
  upstreamRes.on('data', (chunk) => {
    if (overflow) return;
    size += chunk.length;
    if (size > MAX_REWRITE_BYTES) {
      overflow = true;
      upstreamRes.destroy();
      if (!res.headersSent) sendJson(res, 502, { error: 'upstream_response_too_large' });
      return;
    }
    chunks.push(chunk);
  });
  upstreamRes.on('end', () => {
    if (overflow) return;
    const original = Buffer.concat(chunks);
    const body = rewriteBody(original, rewriteContext) ?? original;
    res.writeHead(
      upstreamRes.statusCode ?? 502,
      downstreamResponseHeaders(upstreamRes.headers, {
        'content-length': String(body.length),
        'cache-control': 'no-store',
      }),
    );
    res.end(body);
  });
}

/**
 * Creates the HTTP proxy handler.
 * @param {{ config: object, log: object, agent?: import('node:http').Agent }} deps
 * @returns {(req: object, res: object, route: { pathname: string, upstreamTarget: string, rewriteContext: object }) => void}
 */
export function createHttpProxy({ config, log, agent }) {
  const keepAliveAgent = agent ?? new http.Agent({ keepAlive: true, maxSockets: 256 });
  const host = upstreamHostHeader(config);
  const authorization = upstreamAuthorization(config);

  return (req, res, { pathname, upstreamTarget, rewriteContext }) => {
    const rewrite = shouldRewrite(pathname);
    const upstreamReq = http.request({
      host: config.internalHost,
      port: config.internalPort,
      method: req.method,
      path: upstreamTarget,
      agent: keepAliveAgent,
      headers: upstreamRequestHeaders(req.headers, { host, authorization, identityEncoding: rewrite }),
    });

    upstreamReq.setTimeout(config.httpTimeoutMs, () => {
      upstreamReq.destroy(new Error('upstream timeout'));
    });

    upstreamReq.on('error', (error) => {
      log.warn('request to Obscura failed', { method: req.method, path: pathname, error: error.message });
      if (!res.headersSent) {
        const timedOut = error.message === 'upstream timeout';
        sendJson(res, timedOut ? 504 : 502, {
          error: timedOut ? 'obscura_timeout' : 'obscura_unavailable',
          message: timedOut ? 'Obscura did not answer in time' : 'Obscura is starting or restarting; retry shortly',
        });
      } else {
        res.destroy();
      }
    });

    upstreamReq.on('response', (upstreamRes) => {
      upstreamRes.on('error', () => res.destroy());
      if (rewrite) {
        bufferAndRewrite(upstreamRes, res, rewriteContext);
        return;
      }
      res.writeHead(upstreamRes.statusCode ?? 502, downstreamResponseHeaders(upstreamRes.headers));
      upstreamRes.pipe(res);
    });

    res.on('close', () => {
      if (!res.writableFinished) upstreamReq.destroy();
    });
    req.on('error', () => upstreamReq.destroy());
    req.pipe(upstreamReq);
  };
}
