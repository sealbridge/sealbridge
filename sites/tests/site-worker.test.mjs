import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import worker from '../site-worker.mjs';
import { parseByteRange } from '../media-range.mjs';

const bytes = Uint8Array.from([0, 255, 2, 128, 4, 5, 6, 7, 8, 9]);
const etag = '"demo-v1"';
// Read the source policy independently: the asset stub deliberately supplies none of it.
const policy = (await readFile(new URL('../_headers', import.meta.url), 'utf8'))
  .split('\n\n')[0].split('\n').slice(1).map(line => {
    const colon = line.indexOf(':');
    return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
  });

async function serve({ method = 'GET', range, ifRange, type = 'video/mp4', status = 200,
  assetEtag = etag, data = bytes, includeContentLength = true, extraHeaders = {} } = {}) {
  const headers = new Headers(extraHeaders);
  if (range !== undefined) headers.set('Range', range);
  if (ifRange !== undefined) headers.set('If-Range', ifRange);
  const request = new Request('https://sealbridge.dev/media/demo.mp4', { method, headers });
  const response = await worker.fetch(request, { ASSETS: {
    async fetch(assetRequest) {
      assert.equal(assetRequest.method, 'GET');
      assert.equal(assetRequest.url, request.url);
      assert.equal(assetRequest.headers.get('Range'), null);
      assert.equal(assetRequest.headers.get('If-Range'), null);
      assert.equal(assetRequest.headers.get('Accept-Encoding'), 'identity');
      for (const [name, value] of Object.entries(extraHeaders)) assert.equal(assetRequest.headers.get(name), value);
      return new Response(status === 304 ? null : data, { status, headers: {
        'Content-Type': type, ...(assetEtag === null ? {} : { 'ETag': assetEtag }),
        ...(includeContentLength ? { 'Content-Length': String(data.length) } : {}),
        'Cache-Control': 'public, max-age=0, must-revalidate', 'X-Asset-Metadata': 'preserved',
      } });
    },
  } });
  for (const [name, value] of policy) assert.equal(response.headers.get(name), value, name);
  assert.equal(response.headers.get('Content-Type'), type);
  assert.equal(response.headers.get('ETag'), assetEtag);
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=0, must-revalidate');
  assert.equal(response.headers.get('X-Asset-Metadata'), 'preserved');
  return response;
}

test('full HEAD measures Content-Length when the asset omits it, including empty assets and If-Range fallbacks', async () => {
  for (const data of [bytes, new Uint8Array()]) {
    for (const options of [{}, { range: 'bytes=0-1', ifRange: '"old"' }]) {
      const get = await serve({ ...options, data, includeContentLength: false });
      const head = await serve({ ...options, data, includeContentLength: false, method: 'HEAD' });
      const size = (await get.arrayBuffer()).byteLength;
      assert.equal(get.status, 200);
      assert.equal(head.status, get.status);
      assert.equal(head.headers.get('Content-Length'), String(size));
      assert.equal(head.headers.get('Content-Range'), null);
      assert.equal(head.headers.get('Accept-Ranges'), 'bytes');
      assert.equal(head.body, null);
      assert.equal((await head.arrayBuffer()).byteLength, 0);
    }
  }
});

const cases = [
  { name: 'no Range', status: 200 },
  { name: 'first two bytes', range: 'bytes=0-1', status: 206, start: 0, end: 1 },
  { name: 'inclusive bounds', range: 'bytes=2-5', status: 206, start: 2, end: 5 },
  { name: 'open-ended', range: 'bytes=7-', status: 206, start: 7, end: 9 },
  { name: 'suffix', range: 'bytes=-3', status: 206, start: 7, end: 9 },
  { name: 'suffix exceeding size', range: 'bytes=-100', status: 206, start: 0, end: 9 },
  { name: 'clamped end', range: 'bytes=8-100', status: 206, start: 8, end: 9 },
  { name: 'case-insensitive unit', range: 'BYTES=0-1', status: 206, start: 0, end: 1 },
  { name: 'start equals size', range: 'bytes=10-', status: 416 },
  { name: 'start exceeds size', range: 'bytes=99999999-', status: 416 },
  { name: 'zero suffix', range: 'bytes=-0', status: 416 },
  { name: 'large start', range: 'bytes=999999999999999999999999-', status: 416 },
  { name: 'large end', range: 'bytes=8-999999999999999999999999', status: 206, start: 8, end: 9 },
  { name: 'large suffix', range: 'bytes=-999999999999999999999999', status: 206, start: 0, end: 9 },
  ...['bytes=0-1,4-5', 'bytes=', 'bytes=-', 'bytes=4-2', 'items=0-1', 'bytes=a-b', 'bytes=1.5-2', 'bytes=1-2junk']
    .map(range => ({ name: `fallback ${range}`, range, status: 200 })),
];

for (const { name, range, status, start, end } of cases) {
  test(`${name}: GET and HEAD have identical status and headers, with exact bytes only on GET`, async () => {
    const get = await serve({ range });
    const head = await serve({ method: 'HEAD', range });
    assert.equal(get.status, status);
    assert.equal(head.status, status);
    assert.deepEqual([...head.headers], [...get.headers]);
    assert.equal(get.headers.get('Accept-Ranges'), 'bytes');
    const expected = status === 416 ? new Uint8Array() : status === 206 ? bytes.slice(start, end + 1) : bytes;
    assert.equal(get.headers.get('Content-Length'), String(expected.length));
    assert.equal(get.headers.get('Content-Range'), status === 416 ? 'bytes */10'
      : status === 206 ? `bytes ${start}-${end}/10` : null);
    assert.deepEqual(new Uint8Array(await get.arrayBuffer()), expected);
    assert.equal(head.body, null);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  });
}

test('If-Range honors only an exact strong ETag; other validators return the full asset', async () => {
  for (const [ifRange, assetEtag, status] of [
    [etag, etag, 206], ['"old"', etag, 200], [`W/${etag}`, etag, 200],
    [etag, null, 200],
    [`W/${etag}`, `W/${etag}`, 200], ['Wed, 21 Oct 2015 07:28:00 GMT', etag, 200],
  ]) for (const method of ['GET', 'HEAD']) {
    const response = await serve({ method, range: 'bytes=0-1', ifRange, assetEtag });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('Content-Length'), status === 206 ? '2' : '10');
    assert.equal(response.headers.get('Content-Range'), status === 206 ? 'bytes 0-1/10' : null);
    assert.equal((await response.arrayBuffer()).byteLength, method === 'HEAD' ? 0 : status === 206 ? 2 : 10);
  }
  const response = await serve({ range: 'bytes=99999999-', ifRange: '"old"' });
  assert.equal(response.status, 200);
});

test('WebM and other /media/* representations retain the asset Content-Type', async () => {
  for (const type of ['video/webm', 'image/png', 'application/octet-stream']) {
    const response = await serve({ type, range: 'bytes=0-1' });
    assert.equal(response.status, 206);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes.slice(0, 2));
  }
});

test('missing assets and conditional responses keep status, policy, validators, and HEAD semantics', async () => {
  for (const status of [404, 304]) for (const method of ['GET', 'HEAD']) {
    const response = await serve({ status, method, range: 'bytes=0-1', extraHeaders: { 'If-None-Match': etag } });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('Content-Range'), null);
    assert.equal((await response.arrayBuffer()).byteLength, method === 'HEAD' || status === 304 ? 0 : 10);
  }
});

test('empty assets have no satisfiable ranges', async () => {
  for (const range of ['bytes=0-', 'bytes=0-1', 'bytes=-1', 'bytes=-0']) {
    assert.deepEqual(parseByteRange(range, 0), { unsatisfiable: true });
    for (const method of ['GET', 'HEAD']) {
      const response = await serve({ method, range, data: new Uint8Array() });
      assert.equal(response.status, 416);
      assert.equal(response.headers.get('Content-Range'), 'bytes */0');
      assert.equal(response.headers.get('Content-Length'), '0');
      assert.equal((await response.arrayBuffer()).byteLength, 0);
    }
  }
});

test('non-media requests pass through unchanged, including Range and conditional headers', async () => {
  const request = new Request('https://sealbridge.dev/en/', { headers: { Range: 'bytes=0-1', 'If-None-Match': etag } });
  const asset = new Response('landing');
  assert.equal(await worker.fetch(request, { ASSETS: { fetch(received) {
    assert.equal(received, request);
    return asset;
  } } }), asset);
});
