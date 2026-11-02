import { parseByteRange } from './media-range.mjs';

// _headers is not automatically applied to Worker-generated responses.
// Keep these equal to its /* block; the Node tests assert parity on actual responses.
const policy = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

export default {
  async fetch(request, env) {
    if (!new URL(request.url).pathname.startsWith('/media/')) return env.ASSETS.fetch(request);

    const isHead = request.method === 'HEAD';
    const isRead = isHead || request.method === 'GET';
    const assetRequest = new Request(request);
    if (isRead) {
      // Always fetch the full representation, independent of asset-cache range support.
      assetRequest.headers.delete('Range');
      assetRequest.headers.delete('If-Range');
      assetRequest.headers.set('Accept-Encoding', 'identity');
    }
    // Fetch GET metadata for HEAD so range status/headers follow the same path.
    const asset = await env.ASSETS.fetch(isHead ? new Request(assetRequest, { method: 'GET' }) : assetRequest);
    const headers = new Headers(asset.headers);
    for (const [name, value] of Object.entries(policy)) headers.set(name, value);
    let status = asset.status;
    let body = asset.body;

    if (isRead && status === 200) {
      headers.set('Accept-Ranges', 'bytes');
      const range = request.headers.get('Range');
      const ifRange = request.headers.get('If-Range');
      const etag = headers.get('ETag');
      // Only an exact strong ETag enables If-Range. Dates and weak/missing tags use 200.
      if (range && (ifRange === null || (etag?.startsWith('"') && ifRange === etag))) {
        // Current media files are about 3 MB. Buffer range requests; full GETs stream.
        const bytes = await asset.arrayBuffer();
        const size = bytes.byteLength;
        const selected = parseByteRange(range, size);
        if (selected?.unsatisfiable) {
          status = 416;
          headers.set('Content-Range', `bytes */${size}`);
          headers.set('Content-Length', '0');
          body = null;
        } else if (selected) {
          const { start, end } = selected;
          status = 206;
          headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
          headers.set('Content-Length', String(end - start + 1));
          body = isHead ? null : bytes.slice(start, end + 1);
        } else {
          headers.set('Content-Length', String(size));
          body = isHead ? null : bytes;
        }
      } else if (isHead) {
        // Assets may omit the length on streamed GETs. Measure before dropping
        // the body so HEAD still advertises the full representation's size.
        if (!headers.has('Content-Length')) {
          headers.set('Content-Length', String((await asset.arrayBuffer()).byteLength));
        } else {
          await body?.cancel();
        }
        body = null;
      }
    } else if (isHead) {
      await body?.cancel();
      body = null;
    }
    return new Response(body, { status, headers });
  },
};
