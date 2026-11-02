import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const directory = path.dirname(fileURLToPath(import.meta.url));
const rules = [];
for (const line of (await readFile(path.join(directory, '_headers'), 'utf8')).split('\n')) {
  if (!line.trim() || line.trim().startsWith('#')) continue;
  if (line.startsWith('/')) rules.push({ route: line.trim(), headers: {} });
  else {
    const colon = line.indexOf(':');
    if (colon > 0 && rules.length) rules.at(-1).headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
}
function policyFor(pathname) {
  return Object.assign({}, ...rules.filter(rule => rule.route === '/*' || rule.route === pathname).map(rule => rule.headers));
}
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webm': 'video/webm', '.mp4': 'video/mp4', '.png': 'image/png' };
for (const [target, port] of [['site', 4173], ['invite', 4174]]) {
  const root = path.join(directory, 'dist', target);
  const server = createServer(async (req, res) => {
    // No request logging. This server never inspects query values or fragments.
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      let file = path.resolve(root, '.' + pathname);
      if (!file.startsWith(root + path.sep) && file !== root) throw new Error('OUTSIDE_ROOT');
      if (pathname.endsWith('/') || !path.extname(file)) file = path.join(file, 'index.html');
      // HEAD and range validation need metadata only; stream GET bodies without buffering the whole file.
      const info = await stat(file);
      if (!info.isFile()) throw new Error('NOT_A_FILE');
      const size = info.size;
      const headers = { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream',
        'Accept-Ranges': 'bytes', ...policyFor(pathname) };
      // Single byte ranges cover browser media playback and seeking, including suffix ranges.
      const range = req.headers.range;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        let start = Number(match?.[1] || 0);
        let end = match?.[2] ? Number(match[2]) : size - 1;
        if (match && !match[1] && match[2]) {
          start = Math.max(0, size - Number(match[2]));
          end = size - 1;
        }
        if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
          || start >= size || start > end) {
          res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 });
          res.end();
          return;
        }
        end = Math.min(end, size - 1);
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
        if (req.method === 'HEAD') res.end();
        else await pipeline(createReadStream(file, { start, end }), res);
        return;
      }
      res.writeHead(200, { ...headers, 'Content-Length': size });
      if (req.method === 'HEAD') res.end();
      else await pipeline(createReadStream(file), res);
    } catch {
      // A disconnected client or a failed stream has already started the response.
      if (res.headersSent || res.destroyed) {
        res.destroy();
        return;
      }
      res.writeHead(404, { ...policyFor(''), 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
  });
  server.listen(port, '127.0.0.1', () => console.log(`${target}: http://127.0.0.1:${port}${target === 'invite' ? '/i' : '/'}`));
  const close = () => server.close();
  process.on('SIGINT', close); process.on('SIGTERM', close);
}
