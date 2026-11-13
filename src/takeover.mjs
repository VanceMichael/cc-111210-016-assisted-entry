import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError } from './http.mjs';

const TERMINAL = new Set(['completed', 'failed', 'expired', 'aborted', 'browser-lost']);
const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();

// 接管工单：一次性领取、有期限、持久化到磁盘。
// 凭据只保存散列，原文只出现在返回给调用方的接管入口中，不写入日志。
export class TakeoverManager {
  constructor(directory, { ttlMs = 300000, ledger = null, onSettle = null } = {}) {
    this.directory = join(directory, 'takeovers');
    this.ttlMs = ttlMs;
    this.ledger = ledger;
    this.onSettle = onSettle;
    this.tickets = new Map();
    this.timers = new Map();
  }

  async load() {
    await mkdir(this.directory, { recursive: true });
    for (const file of await readdir(this.directory)) {
      if (!file.endsWith('.json')) continue;
      const ticket = JSON.parse(await readFile(join(this.directory, file), 'utf8'));
      if (!TERMINAL.has(ticket.status)) {
        // 进程重启后浏览器已不存在：明确标记丢失，要求重新开始会话，绝不伪造续采。
        ticket.status = 'browser-lost';
        ticket.reason = '服务重启后浏览器会话已丢失，请重新开始会话';
        ticket.closedAt = now();
        await this.persist(ticket);
        await this.log('system', 'takeover.browser-lost', ticket, { reason: ticket.reason });
      }
      this.tickets.set(ticket.id, ticket);
    }
  }

  stop() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  async log(actor, action, ticket, detail = {}) {
    await this.ledger?.record({ actor, action, session: ticket.sessionId, ticket: ticket.id, detail });
  }

  async persist(ticket) {
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, ticket.id + '.json');
    const temporary = path + '.' + randomUUID();
    await writeFile(temporary, JSON.stringify(ticket, null, 2), { flag: 'wx' });
    await rename(temporary, path);
  }

  arm(ticket) {
    const delay = Math.max(0, Date.parse(ticket.expiresAt) - Date.now());
    const timer = setTimeout(() => { this.expire(ticket.id).catch(() => {}); }, delay);
    timer.unref();
    this.timers.set(ticket.id, timer);
  }

  disarm(id) {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }

  async create({ sessionId, context }) {
    const id = randomUUID();
    const token = randomBytes(24).toString('base64url');
    const ticket = {
      id,
      sessionId,
      tokenHash: hash(token),
      operatorHash: null,
      status: 'pending',
      reason: null,
      context,
      createdAt: now(),
      expiresAt: new Date(Date.now() + this.ttlMs).toISOString(),
      claimedAt: null,
      closedAt: null,
    };
    this.tickets.set(id, ticket);
    await this.persist(ticket);
    this.arm(ticket);
    await this.log('robot', 'takeover.created', ticket, { expiresAt: ticket.expiresAt });
    return { ticket, token };
  }

  get(id) {
    const ticket = this.tickets.get(id);
    if (!ticket) throw new HttpError(404, '接管工单不存在');
    return ticket;
  }

  async view(id) {
    const ticket = await this.refresh(this.get(id));
    return {
      id: ticket.id,
      sessionId: ticket.sessionId,
      status: ticket.status,
      reason: ticket.reason,
      expiresAt: ticket.expiresAt,
      context: { account: ticket.context.account, institution: ticket.context.institution, url: ticket.context.url },
    };
  }

  async refresh(ticket) {
    if (!TERMINAL.has(ticket.status) && ticket.status !== 'verifying' && Date.parse(ticket.expiresAt) <= Date.now()) {
      await this.expire(ticket.id);
    }
    return ticket;
  }

  async claim(id, token) {
    const ticket = await this.refresh(this.get(id));
    if (TERMINAL.has(ticket.status)) throw new HttpError(409, ticket.reason ?? '接管已结束，不能重复领取');
    if (ticket.status !== 'pending') throw new HttpError(409, '接管凭据已被领取，不能重复使用');
    if (!token || hash(token) !== ticket.tokenHash) throw new HttpError(403, '接管凭据无效');
    const key = randomBytes(24).toString('base64url');
    ticket.status = 'claimed';
    ticket.operatorHash = hash(key);
    ticket.claimedAt = now();
    await this.persist(ticket);
    await this.log('human', 'takeover.claimed', ticket);
    return { ticket, key };
  }

  async authorize(id, key, { allow = ['claimed'] } = {}) {
    const ticket = await this.refresh(this.get(id));
    if (TERMINAL.has(ticket.status)) throw new HttpError(409, ticket.reason ?? '接管已结束，不能重复提交');
    if (!allow.includes(ticket.status)) throw new HttpError(409, '接管当前状态不允许该操作');
    if (!ticket.operatorHash || !key || hash(key) !== ticket.operatorHash) throw new HttpError(403, '操作凭据无效');
    return ticket;
  }

  async beginCompletion(id, key) {
    const ticket = await this.authorize(id, key);
    ticket.status = 'verifying'; // 同步切换状态，阻止并发的重复提交
    await this.persist(ticket);
    return ticket;
  }

  async settle(ticket, status, reason, actor, action) {
    if (TERMINAL.has(ticket.status)) return ticket;
    ticket.status = status;
    ticket.reason = reason;
    ticket.closedAt = now();
    this.disarm(ticket.id);
    await this.persist(ticket);
    await this.log(actor, action, ticket, reason ? { reason } : {});
    if (this.onSettle && ['failed', 'expired', 'aborted'].includes(status)) await this.onSettle(ticket);
    return ticket;
  }

  complete(id) {
    return this.settle(this.get(id), 'completed', null, 'human', 'takeover.completed');
  }

  fail(id, reason) {
    return this.settle(this.get(id), 'failed', reason, 'system', 'takeover.failed');
  }

  async abort(id, key, reason) {
    const ticket = await this.authorize(id, key);
    return this.settle(ticket, 'aborted', reason ?? '经办人放弃接管', 'human', 'takeover.aborted');
  }

  async expire(id) {
    const ticket = this.tickets.get(id);
    if (!ticket || TERMINAL.has(ticket.status) || ticket.status === 'verifying') return;
    try {
      await this.settle(ticket, 'expired', '人工接管超时，未在期限内完成', 'system', 'takeover.expired');
    } catch {
      // 服务关闭过程中的过期清理失败可忽略
    }
  }

  async cancelForSession(sessionId, reason) {
    for (const ticket of this.tickets.values()) {
      if (ticket.sessionId === sessionId && !TERMINAL.has(ticket.status) && ticket.status !== 'verifying') {
        await this.settle(ticket, 'aborted', reason, 'system', 'takeover.aborted');
      }
    }
  }
}
