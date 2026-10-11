#!/usr/bin/env node
/**
 * tools/serve.mjs — dependency-free static file server for the demo.
 *
 * Usage:  node tools/serve.mjs [--port 8177] [--host 127.0.0.1] [--root .]
 *
 * Exists because the demo uses native ES modules + fetch() for the OBJ/MTL
 * assets, which the file:// protocol blocks. No dependencies, no build step.
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { port: 8177, host: '127.0.0.1', root: PROJECT_ROOT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') out.port = Number(argv[++i]) || out.port;
    else if (a === '--host' || a === '-h') out.host = argv[++i] || out.host;
    else if (a === '--root' || a === '-r') out.root = path.resolve(argv[++i] || out.root);
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.obj': 'text/plain; charset=utf-8',
  '.mtl': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  if (body === undefined || body === null) res.end();
  else res.end(body);
}

async function resolveTarget(root, urlPath) {
  // Decode, normalise, and refuse anything that escapes the root.
  let decoded;
  try { decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]); }
  catch { return null; }
  if (decoded.includes('\0')) return null;

  let rel = path.normalize(decoded).replace(/^([/\\])+/, '');
  let abs = path.resolve(root, rel);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) return null;

  let st;
  try { st = await fsp.stat(abs); } catch { return null; }
  if (st.isDirectory()) {
    abs = path.join(abs, 'index.html');
    try { st = await fsp.stat(abs); } catch { return null; }
  }
  if (!st.isFile()) return null;
  return { abs, size: st.size, mtime: st.mtime };
}

export function createServer({ root = PROJECT_ROOT } = {}) {
  return http.createServer(async (req, res) => {
    const started = Date.now();
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send(res, 405, 'Method Not Allowed', { 'Content-Type': 'text/plain' });
      }

      const found = await resolveTarget(root, req.url || '/');
      if (!found) {
        console.log(`${req.method} ${req.url} -> 404`);
        return send(res, 404, `404 Not Found: ${req.url}`, { 'Content-Type': 'text/plain; charset=utf-8' });
      }

      const ext = path.extname(found.abs).toLowerCase();
      const type = MIME[ext] || 'application/octet-stream';

      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': found.size,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      if (req.method === 'HEAD') return res.end();

      await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(found.abs);
        stream.on('error', reject);
        stream.on('end', resolve);
        stream.pipe(res);
      });
      if (process.env.SERVE_VERBOSE) {
        console.log(`${req.method} ${req.url} -> 200 ${found.size}B ${Date.now() - started}ms`);
      }
    } catch (err) {
      console.error('serve error:', err);
      if (!res.headersSent) send(res, 500, 'Internal Server Error', { 'Content-Type': 'text/plain' });
      else res.end();
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { port, host, root } = parseArgs(process.argv.slice(2));
  const server = createServer({ root });
  server.listen(port, host, () => {
    const url = `http://${host}:${port}/`;
    console.log(`YAMATO FLEET 2199 — serving ${root}`);
    console.log(`  ${url}`);
    console.log('  Ctrl-C to stop');
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Try: node tools/serve.mjs --port ${port + 1}`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { server.close(() => process.exit(0)); });
  }
}

export default createServer;
