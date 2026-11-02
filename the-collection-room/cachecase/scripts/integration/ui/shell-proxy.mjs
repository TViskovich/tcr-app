// Test-only web shell for the CacheCase UI tests. Serves the app's client
// bundle from a local-only Metro (8090) behind a plain SPA shell on 8091, so
// no request triggers Expo's server-side rendering (app.json web.output is
// "static", which can't render the AsyncStorage-backed Supabase client in
// Node). Nothing in the repo's app code or config is changed.
//
// WEB_PATCHES: native-only module-load code that throws on web, stubbed in
// the served bundle only. Each entry must match, or the proxy says so.
import { Buffer } from 'node:buffer';
import http from 'node:http';

const METRO = 'http://127.0.0.1:8090';
const ENTRY =
  '/node_modules/expo-router/entry.bundle?platform=web&dev=true&hot=false&lazy=true&transform.engine=hermes&transform.routerRoot=app&unstable_transformProfile=hermes-stable';
const SHELL = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body,#root{height:100%;margin:0}body{overflow:hidden}#root{display:flex}</style>
</head><body><div id="root"></div><script src="${ENTRY}" defer></script></body></html>`;

const WEB_PATCHES = [
  // lib/share/share-image.ts: expo-file-system Directory at module load.
  ["new _expoFileSystem.Directory(_expoFileSystem.Paths.cache, 'share-images')", "({ uri: 'web-test-stub', exists: false, create() {} })"],
];

const isAsset = (url) => /\.bundle|\.map|^\/assets\/|^\/_expo\/|^\/node_modules\/|platform=web|^\/symbolicate|^\/favicon/.test(url);

http
  .createServer(async (req, res) => {
    if (!isAsset(req.url)) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(SHELL);
    }
    try {
      const upstream = await fetch(METRO + req.url, { method: req.method });
      const headers = {};
      upstream.headers.forEach((v, k) => {
        if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(k)) headers[k] = v;
      });
      res.writeHead(upstream.status, headers);
      if (req.url.includes('entry.bundle')) {
        let body = await upstream.text();
        for (const [from, to] of WEB_PATCHES) {
          if (!body.includes(from)) console.warn(`web patch did not match: ${from}`);
          body = body.replaceAll(from, to);
        }
        return res.end(body);
      }
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (e) {
      res.writeHead(502);
      res.end(String(e));
    }
  })
  .listen(8091, '127.0.0.1', () => console.log('shell proxy on http://127.0.0.1:8091'));
