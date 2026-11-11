// Test helpers: free ports, a raw HTTP client (full header control, including
// Host), and a tiny WebSocket client for text frames.

import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';

export const TOKEN = 'test-token-abcdefghijklmnop0123';
export const INTERNAL_TOKEN = 'internal-token-0123456789abcdef0123456789abcdef';

export async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false });
    req.on('error', reject);
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.end(body);
  });
}

function encodeText(text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = randomBytes(4);
  const masked = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]));
  const header =
    payload.length < 126
      ? Buffer.from([0x81, 0x80 | payload.length])
      : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([header, mask, masked]);
}

// Connects a WebSocket; resolves { status, headers, socket, events } where
// events emits 'message' (text) and 'close'. Non-101 responses resolve with
// the status and body instead of a socket.
export function wsConnect(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      agent: false,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        ...headers,
      },
    });
    req.on('error', reject);
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('upgrade', (res, socket, head) => {
      const events = new EventEmitter();
      let buffer = head;
      const drain = () => {
        while (buffer.length >= 2) {
          let length = buffer[1] & 0x7f;
          let offset = 2;
          if (length === 126) {
            if (buffer.length < 4) return;
            length = buffer.readUInt16BE(2);
            offset = 4;
          }
          if (buffer.length < offset + length) return;
          const opcode = buffer[0] & 0x0f;
          const payload = buffer.subarray(offset, offset + length);
          buffer = buffer.subarray(offset + length);
          if (opcode === 0x1) events.emit('message', payload.toString('utf8'));
        }
      };
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        drain();
      });
      socket.on('close', () => events.emit('close'));
      drain();
      resolve({
        status: res.statusCode,
        headers: res.headers,
        socket,
        events,
        send: (text) => socket.write(encodeText(text)),
        next: () => new Promise((done) => events.once('message', done)),
        closed: () => new Promise((done) => (socket.destroyed ? done() : events.once('close', done))),
      });
    });
    req.end();
  });
}

// Stand-in for child_process.spawn that never starts a process.
export function stubSpawn(record = []) {
  return (bin, args, options) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.kill = (signal) => {
      record.push(['kill', signal]);
      setImmediate(() => child.emit('exit', null, signal));
      return true;
    };
    record.push(['spawn', bin, args, options]);
    setImmediate(() => child.emit('spawn'));
    return child;
  };
}

export const silentLog = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

export function captureLog() {
  const lines = [];
  const make = (level) => (message, fields) => lines.push({ level, message, fields });
  return { lines, log: { debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error') } };
}

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
