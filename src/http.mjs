import { createServer } from 'node:http';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function readBody(request, limit = 65536) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, '请求体过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, '请求体不是有效的 JSON');
  }
}

export async function listen(handler, port = 0) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const result = await handler(url, request);
      const status = result.status ?? 200;
      const headers = { 'content-type': result.type ?? 'application/json; charset=utf-8', ...result.headers };
      response.writeHead(status, headers);
      response.end(Buffer.isBuffer(result.body) || typeof result.body === 'string'
        ? result.body : JSON.stringify(result.body));
    } catch (error) {
      response.writeHead(error.status ?? 400, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeIdleConnections();
    }),
  };
}

export async function get(base, path) {
  const url = new URL(path, base);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('演练源只允许本地地址');
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`来源返回 ${response.status}`);
  return response;
}
