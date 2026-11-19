/*
 * Production static server for the React build (Azure App Service startup command: `node server.js`).
 *
 * Replaces `pm2 serve`, which reads each file whole, ignores Range requests and sends no caching or
 * compression headers: every session start re-downloaded the ~6.5 MB of avatar clips, and the JS bundle
 * went out uncompressed. This server adds:
 *   - Range requests (206) so video can buffer and seek,
 *   - ETag / Last-Modified / Cache-Control so repeat visits come from the browser cache,
 *   - gzip for text assets,
 *   - single-page-app fallback to index.html for client routes such as /dashboard.
 * No dependencies: Node's standard library only. Copied into build/ by `npm run build`.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8080;
const SELF = path.basename(__filename);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.map', '.svg', '.txt']);
const gzipCache = new Map(); // path -> { mtimeMs, body }

function cacheControl(urlPath) {
  if (urlPath === '/' || urlPath.endsWith('.html')) return 'no-cache'; // always revalidate the app shell
  if (urlPath.startsWith('/static/')) return 'public, max-age=31536000, immutable'; // hashed build files
  return 'public, max-age=604800'; // avatar clips, images: a week, revalidated by ETag afterwards
}

function resolveFile(urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const filePath = path.normalize(path.join(ROOT, decoded));
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) return null; // no path traversal
  if (path.basename(filePath) === SELF) return null; // never serve this script
  try {
    const stat = fs.statSync(filePath);
    if (stat.isFile()) return { filePath, stat };
  } catch (_) { /* not found */ }
  return null;
}

function send(req, res, urlPath, file) {
  const { filePath, stat } = file;
  const ext = path.extname(filePath).toLowerCase();
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Cache-Control': cacheControl(urlPath),
    ETag: etag,
    'Last-Modified': stat.mtime.toUTCString(),
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
  };

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }

  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start = match && match[1] !== '' ? Number(match[1]) : NaN;
    let end = match && match[2] !== '' ? Number(match[2]) : stat.size - 1;
    if (match && match[1] === '' && match[2] !== '') { // suffix range: last N bytes
      start = Math.max(0, stat.size - Number(match[2]));
      end = stat.size - 1;
    }
    if (!match || Number.isNaN(start) || start > end || start >= stat.size) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    end = Math.min(end, stat.size - 1);
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(filePath, { start, end }).pipe(res);
  }

  const wantsGzip = COMPRESSIBLE.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (wantsGzip) {
    let cached = gzipCache.get(filePath);
    if (!cached || cached.mtimeMs !== stat.mtimeMs) {
      cached = { mtimeMs: stat.mtimeMs, body: zlib.gzipSync(fs.readFileSync(filePath)) };
      gzipCache.set(filePath, cached);
    }
    res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': cached.body.length });
    return res.end(req.method === 'HEAD' ? undefined : cached.body);
  }

  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end();
  return fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }
  let urlPath;
  try {
    urlPath = new URL(req.url, 'http://localhost').pathname;
  } catch (_) {
    res.writeHead(400);
    return res.end();
  }
  const file = resolveFile(urlPath === '/' ? '/index.html' : urlPath);
  if (file) return send(req, res, urlPath, file);

  // Client-side routes (/dashboard, /session, ...) get the app shell; missing files with an extension 404.
  if (path.extname(urlPath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  return send(req, res, '/index.html', resolveFile('/index.html'));
});

server.listen(PORT, () => console.log(`KCoach frontend serving ${ROOT} on port ${PORT}`));
