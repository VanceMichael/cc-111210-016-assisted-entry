import { readFile } from 'node:fs/promises';
import { listen } from '../src/http.mjs';
import { createHash } from 'node:crypto';
export async function startFixture() {

  async function route(){return {status:404,body:{}};}

  return listen(async (url, request) => {
    if (url.pathname === '/app.js') return { type: 'text/javascript; charset=utf-8', body: await readFile(new URL('../portal/app.js', import.meta.url), 'utf8') };
    if (url.pathname === '/') return { type: 'text/html; charset=utf-8', body: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>业务演练门户</title><style>body{font:18px sans-serif;padding:24px}button{padding:8px;margin:6px}table{border-collapse:collapse}td,th{border:1px solid #aaa;padding:10px}.lane{border:2px solid #888;display:inline-block;vertical-align:top;min-height:220px;width:240px;padding:12px}.card{border:1px solid #777;padding:12px;margin:8px;background:#eef}#status{white-space:pre-wrap}</style><main id="app"></main><pre id="status"></pre><script src="/app.js"></script></html>` };
    return route(url, request);
  });
}
