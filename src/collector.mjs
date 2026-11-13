import { randomUUID } from 'node:crypto';
import { readObjects } from './connector.mjs';

// 暂停时给页面打标记并记录账号、机构、地址与待采对象选择器。
async function snapshotContext(page) {
  const marker = randomUUID();
  await page.evaluate(value => { window.__takeoverMarker = value; }, marker);
  const anchor = page.locator('[data-account]');
  if (await anchor.count() === 0) throw new Error('页面缺少账号标识，无法建立接管上下文');
  return {
    url: page.url(),
    account: await anchor.first().getAttribute('data-account'),
    institution: await anchor.first().getAttribute('data-institution'),
    marker,
    targets: '[data-object]',
  };
}

// 恢复前重新核对：账号、机构、页面标记、页面地址、确认状态与待采对象，不能只看 URL。
async function verifyContext(session, context) {
  const { page, handle } = session;
  if (!handle.browser.isConnected()) return { ok: false, reason: '浏览器连接已断开，需要重新开始会话' };
  if (page.isClosed()) return { ok: false, reason: '页面已被关闭，需要重新开始会话' };
  let state;
  try {
    state = await page.evaluate(() => {
      const anchor = document.querySelector('[data-account]');
      return {
        account: anchor?.getAttribute('data-account') ?? null,
        institution: anchor?.getAttribute('data-institution') ?? null,
        marker: window.__takeoverMarker ?? null,
        humanCheck: document.querySelectorAll('[data-human-check]').length,
        objects: document.querySelectorAll('[data-object]').length,
        href: location.href,
      };
    });
  } catch {
    return { ok: false, reason: '页面状态无法读取，可能已导航或刷新' };
  }
  if (state.account !== context.account) return { ok: false, reason: `账号已变更（暂停时为 ${context.account}）` };
  if (state.institution !== context.institution) return { ok: false, reason: `机构已切换（暂停时为 ${context.institution}）` };
  if (state.marker !== context.marker) return { ok: false, reason: '页面标记丢失，页面可能已刷新或导航' };
  if (state.href !== context.url) return { ok: false, reason: '页面地址已变化' };
  if (state.humanCheck > 0) return { ok: false, reason: '人工确认尚未完成' };
  if (state.objects === 0) return { ok: false, reason: '待采对象仍不可见，确认可能未完成' };
  return { ok: true };
}

export class Collector {
  constructor({ sessions, takeovers, store, ledger }) {
    this.sessions = sessions;
    this.takeovers = takeovers;
    this.store = store;
    this.ledger = ledger;
  }

  async start({ key }) {
    const session = await this.sessions.create({ key });
    await this.ledger.record({ actor: 'robot', action: 'session.started', session: session.id, detail: { key } });
    try {
      const blocked = await session.page.locator('[data-human-check]').count() > 0;
      if (blocked) {
        // 遇到人工确认页：暂停会话，生成有期限的接管入口，机器人不再点击或导航。
        const context = await snapshotContext(session.page);
        const { ticket, token } = await this.takeovers.create({ sessionId: session.id, context });
        this.sessions.pause(session.id);
        await this.ledger.record({
          actor: 'robot', action: 'collection.paused', session: session.id, ticket: ticket.id,
          detail: { account: context.account, institution: context.institution, targets: context.targets },
        });
        return { status: 'paused', session: session.id, worker: session.worker, takeover: { id: ticket.id, expiresAt: ticket.expiresAt, token } };
      }
      const receipt = await this.collectAndSave(session, null);
      await this.ledger.record({ actor: 'robot', action: 'session.completed', session: session.id, detail: { key } });
      await this.sessions.finish(session.id, 'completed');
      return { status: 'completed', session: session.id, worker: session.worker, receipt };
    } catch (error) {
      await this.ledger.record({ actor: 'system', action: 'session.failed', session: session.id, detail: { reason: error.message } });
      await this.sessions.finish(session.id, 'failed', error.message);
      throw error;
    }
  }

  async collectAndSave(session, ticketId) {
    const objects = await readObjects(session.page);
    const receipt = await this.store.save(session.key, { session: session.id, ticket: ticketId, objects });
    for (const object of objects) {
      // 台账只写对象标识与版本，不写资料内容。
      await this.ledger.record({
        actor: 'robot', action: 'object.collected', session: session.id, ticket: ticketId,
        detail: { key: object.key, version: object.version },
      });
    }
    return receipt;
  }

  async completeTakeover(ticketId, key) {
    const ticket = await this.takeovers.beginCompletion(ticketId, key);
    const session = this.sessions.get(ticket.sessionId);
    const check = await verifyContext(session, ticket.context);
    if (!check.ok) {
      // 人工切换了机构/账号或关闭了页面：安全结束接管并留下原因。
      await this.ledger.record({ actor: 'system', action: 'resume.rejected', session: session.id, ticket: ticket.id, detail: { reason: check.reason } });
      await this.takeovers.fail(ticket.id, check.reason);
      await this.sessions.finish(session.id, 'failed', check.reason);
      return { status: 'failed', reason: check.reason, ticket: ticket.id };
    }
    await this.ledger.record({
      actor: 'system', action: 'resume.verified', session: session.id, ticket: ticket.id,
      detail: { account: ticket.context.account, institution: ticket.context.institution },
    });
    await this.takeovers.complete(ticket.id);
    this.sessions.resume(session.id);
    await this.ledger.record({ actor: 'robot', action: 'collection.resumed', session: session.id, ticket: ticket.id });
    try {
      const receipt = await this.collectAndSave(session, ticket.id);
      await this.ledger.record({ actor: 'robot', action: 'session.completed', session: session.id, ticket: ticket.id, detail: { key: session.key } });
      await this.sessions.finish(session.id, 'completed');
      return { status: 'completed', ticket: ticket.id, receipt };
    } catch (error) {
      await this.ledger.record({ actor: 'system', action: 'session.failed', session: session.id, ticket: ticket.id, detail: { reason: error.message } });
      await this.sessions.finish(session.id, 'failed', error.message);
      throw error;
    }
  }
}
