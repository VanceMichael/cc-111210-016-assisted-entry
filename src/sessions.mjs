import { randomUUID } from 'node:crypto';
import { openBrowser } from './browser.mjs';
import { HttpError } from './http.mjs';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'lost']);

// 会话互斥：每个浏览器会话只属于一个采集工作者，控制操作须出示 worker 令牌。
export class SessionManager {
  constructor({ source, headless = true } = {}) {
    this.source = source;
    this.headless = headless;
    this.sessions = new Map();
  }
  async create({ key }) {
    const handle = await openBrowser(this.source, { headless: this.headless });
    const session = {
      id: randomUUID(),
      key,
      worker: randomUUID(),
      handle,
      page: handle.page,
      state: 'collecting',
      reason: null,
      createdAt: new Date().toISOString(),
    };
    handle.browser.on('disconnected', () => {
      if (!TERMINAL.has(session.state)) {
        session.state = 'lost';
        session.reason = '浏览器连接已断开，需要重新开始会话';
      }
    });
    this.sessions.set(session.id, session);
    return session;
  }
  get(id) {
    const session = this.sessions.get(id);
    if (!session) throw new HttpError(404, '会话不存在；若服务刚重启，浏览器会话已丢失，请重新开始会话');
    return session;
  }
  pause(id) {
    const session = this.get(id);
    if (session.state !== 'collecting') throw new HttpError(409, '会话当前状态不能暂停');
    session.state = 'paused';
    return session;
  }
  resume(id) {
    const session = this.get(id);
    if (session.state !== 'paused') throw new HttpError(409, '会话不在人工接管状态');
    session.state = 'collecting';
    return session;
  }
  async finish(id, state, reason = null) {
    const session = this.get(id);
    if (TERMINAL.has(session.state)) return session;
    session.state = state;
    session.reason = reason;
    await session.handle.close().catch(() => {});
    return session;
  }
  async cancel(id, worker) {
    const session = this.get(id);
    if (session.worker !== worker) throw new HttpError(403, '无权控制该会话：会话由其他采集工作者持有');
    if (TERMINAL.has(session.state)) throw new HttpError(409, '会话已结束');
    return this.finish(id, 'cancelled', '采集工作者取消会话');
  }
  view(id) {
    const session = this.get(id);
    return { id: session.id, key: session.key, state: session.state, reason: session.reason, createdAt: session.createdAt };
  }
  async dispose() {
    for (const session of this.sessions.values()) await session.handle.close().catch(() => {});
    this.sessions.clear();
  }
}
