import { join } from 'node:path';
import { listen, readBody, HttpError } from './http.mjs';
import { inspect } from './connector.mjs';
import { ReceiptStore } from './store.mjs';
import { Ledger } from './ledger.mjs';
import { SessionManager } from './sessions.mjs';
import { TakeoverManager } from './takeover.mjs';
import { Collector } from './collector.mjs';
import { operatorPage } from './operator-page.mjs';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// 只转发人工产生的输入；返回给台账的描述不包含任何页面资料或输入文本。
async function forwardInput(page, body) {
  if (page.isClosed()) throw new HttpError(409, '页面已关闭，需要重新开始会话');
  switch (body.kind) {
    case 'click': {
      if (typeof body.selector === 'string') {
        if (!/^[#.\[\]\w\s:="-]{1,120}$/.test(body.selector)) throw new HttpError(400, '选择器无效');
        const box = await page.locator(body.selector).first().boundingBox();
        if (!box) throw new HttpError(409, '目标元素当前不可见');
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        return { kind: 'click', selector: body.selector };
      }
      const { x, y } = body;
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 4096 || y > 4096) {
        throw new HttpError(400, '坐标无效');
      }
      await page.mouse.click(x, y);
      return { kind: 'click', x: Math.round(x), y: Math.round(y) };
    }
    case 'type': {
      if (typeof body.text !== 'string' || body.text.length === 0 || body.text.length > 2000) {
        throw new HttpError(400, '文本无效');
      }
      await page.keyboard.type(body.text);
      return { kind: 'type', length: body.text.length }; // 只记录长度，不记录文本
    }
    case 'press': {
      const allowed = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
      if (!allowed.includes(body.press)) throw new HttpError(400, '不支持的按键');
      await page.keyboard.press(body.press);
      return { kind: 'press', press: body.press };
    }
    default:
      throw new HttpError(400, '未知的输入类型');
  }
}

export async function startService({ source, directory, port = 0, takeoverTtlMs = 300000, headless = true }) {
  const store = new ReceiptStore(directory);
  const ledger = new Ledger(join(directory, 'ledger.jsonl'));
  await ledger.load();
  const sessions = new SessionManager({ source, headless });
  const takeovers = new TakeoverManager(directory, {
    ttlMs: takeoverTtlMs,
    ledger,
    onSettle: async ticket => {
      const session = sessions.sessions.get(ticket.sessionId);
      if (session) await sessions.finish(session.id, 'failed', ticket.reason);
    },
  });
  await takeovers.load();
  const collector = new Collector({ sessions, takeovers, store, ledger });
  await ledger.record({ actor: 'system', action: 'service.started' });

  const server = await listen(async (url, request) => {
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.pathname === '/health') return { body: { state: 'ready' } };
    if (url.pathname === '/inspect') {
      const result = await inspect(source, Object.fromEntries(url.searchParams));
      return { body: result };
    }
    if (url.pathname === '/receive') {
      const key = url.searchParams.get('key') ?? 'single';
      const result = await inspect(source, Object.fromEntries(url.searchParams));
      return { body: await store.save(key, result) };
    }
    if (parts[0] === 'receipts' && parts.length === 2) return { body: await store.read(parts[1]) };
    if (parts[0] === 'ledger' && parts.length === 1 && request.method === 'GET') {
      return { body: { events: await ledger.query({ session: url.searchParams.get('session') }) } };
    }
    if (parts[0] === 'sessions' && parts.length === 1 && request.method === 'POST') {
      const body = await readBody(request);
      const key = typeof body.key === 'string' && body.key ? body.key : 'single';
      const result = await collector.start({ key });
      if (result.status === 'paused') {
        const { token, ...rest } = result.takeover;
        result.takeover = { ...rest, claimPath: `/takeovers/${result.takeover.id}/claim?token=${token}` };
      }
      return { body: result };
    }
    if (parts[0] === 'sessions' && ID.test(parts[1] ?? '')) {
      if (parts.length === 2 && request.method === 'GET') return { body: sessions.view(parts[1]) };
      if (parts.length === 3 && parts[2] === 'cancel' && request.method === 'POST') {
        const body = await readBody(request);
        const session = await sessions.cancel(parts[1], body.worker);
        await takeovers.cancelForSession(session.id, '采集工作者取消会话');
        await ledger.record({ actor: 'robot', action: 'session.cancelled', session: session.id });
        return { body: sessions.view(session.id) };
      }
    }
    if (parts[0] === 'takeovers' && ID.test(parts[1] ?? '')) {
      const id = parts[1];
      if (parts.length === 2 && request.method === 'GET') return { body: await takeovers.view(id) };
      if (parts.length === 3 && parts[2] === 'claim' && request.method === 'GET') {
        const { ticket, key } = await takeovers.claim(id, url.searchParams.get('token'));
        return { type: 'text/html; charset=utf-8', body: operatorPage({ ticket, key }) };
      }
      if (parts.length === 3 && parts[2] === 'operate' && request.method === 'GET') {
        const key = url.searchParams.get('key');
        const ticket = await takeovers.authorize(id, key, { allow: ['claimed', 'verifying'] });
        return { type: 'text/html; charset=utf-8', body: operatorPage({ ticket, key }) };
      }
      if (parts.length === 3 && parts[2] === 'view' && request.method === 'GET') {
        const ticket = await takeovers.authorize(id, url.searchParams.get('key'));
        const session = sessions.get(ticket.sessionId);
        if (session.state === 'lost') throw new HttpError(409, '浏览器连接已断开，需要重新开始会话');
        if (session.state !== 'paused') throw new HttpError(409, '会话不在人工接管状态');
        try {
          return { type: 'image/jpeg', body: await session.page.screenshot({ type: 'jpeg', quality: 60 }) };
        } catch {
          throw new HttpError(409, '页面已不可用，需要重新开始会话');
        }
      }
      if (parts.length === 3 && parts[2] === 'input' && request.method === 'POST') {
        const body = await readBody(request);
        const ticket = await takeovers.authorize(id, body.auth);
        const session = sessions.get(ticket.sessionId);
        if (session.state !== 'paused') throw new HttpError(409, '会话不在人工接管状态');
        const detail = await forwardInput(session.page, body);
        await ledger.record({ actor: 'human', action: 'operator.input', session: session.id, ticket: id, detail });
        return { body: { ok: true } };
      }
      if (parts.length === 3 && parts[2] === 'complete' && request.method === 'POST') {
        const body = await readBody(request);
        return { body: await collector.completeTakeover(id, body.auth) };
      }
      if (parts.length === 3 && parts[2] === 'abort' && request.method === 'POST') {
        const body = await readBody(request);
        const ticket = await takeovers.abort(id, body.auth,
          typeof body.reason === 'string' ? body.reason.slice(0, 200) : undefined);
        return { body: { status: ticket.status, reason: ticket.reason } };
      }
    }
    return { status: 404, body: { error: '接口不存在' } };
  }, port);

  return {
    url: server.url,
    sessions,
    takeovers,
    ledger,
    collector,
    close: async () => {
      takeovers.stop();
      await sessions.dispose();
      await server.close();
    },
  };
}
