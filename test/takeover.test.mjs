import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService } from '../src/service.mjs';
import { startFixture } from '../fixtures/source.mjs';

async function setup({ ttl = 5000 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'takeover-'));
  const fixture = await startFixture();
  const service = await startService({ source: fixture.url, directory, takeoverTtlMs: ttl });
  return {
    directory,
    fixture,
    service,
    async cleanup() {
      await service.close();
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const post = (service, path, body) => fetch(service.url + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});

async function startPaused(service, key = 't-' + Math.random().toString(36).slice(2, 8)) {
  const response = await post(service, '/sessions', { key });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.status, 'paused');
  assert.ok(body.takeover.claimPath.includes('/claim?token='));
  return body;
}

async function claim(service, started) {
  const response = await fetch(service.url + started.takeover.claimPath);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /人工接管操作台/);
  return html.match(/data-key="([^"]+)"/)[1];
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('遇到人工确认页时暂停会话并生成有期限的接管入口', async () => {
  const env = await setup();
  try {
    const started = await startPaused(env.service);
    const session = await (await fetch(`${env.service.url}/sessions/${started.session}`)).json();
    assert.equal(session.state, 'paused');
    const ticket = await (await fetch(`${env.service.url}/takeovers/${started.takeover.id}`)).json();
    assert.equal(ticket.status, 'pending');
    assert.ok(Date.parse(ticket.expiresAt) > Date.now());
    assert.equal(ticket.context.account, 'operator-1');
    assert.equal(ticket.context.institution, 'museum-a');
    assert.ok(!('tokenHash' in ticket) && !('operatorHash' in ticket), '凭据材料不得随状态外泄');
    const { events } = await (await fetch(`${env.service.url}/ledger?session=${started.session}`)).json();
    assert.ok(events.some(e => e.action === 'collection.paused' && e.actor === 'robot'));
  } finally { await env.cleanup(); }
});

test('接管凭据只允许一次领取，错误凭据被拒绝', async () => {
  const env = await setup();
  try {
    const started = await startPaused(env.service);
    const wrong = await fetch(`${env.service.url}/takeovers/${started.takeover.id}/claim?token=wrong`);
    assert.equal(wrong.status, 403);
    const auth = await claim(env.service, started);
    assert.ok(auth.length > 20);
    const again = await fetch(env.service.url + started.takeover.claimPath);
    assert.equal(again.status, 409);
    assert.match((await again.json()).error, /已被领取/);
    const ticket = await (await fetch(`${env.service.url}/takeovers/${started.takeover.id}`)).json();
    assert.equal(ticket.status, 'claimed');
  } finally { await env.cleanup(); }
});

test('人工超时后接管入口失效，会话安全结束', async () => {
  const env = await setup({ ttl: 300 });
  try {
    const started = await startPaused(env.service);
    await sleep(700);
    const ticket = await (await fetch(`${env.service.url}/takeovers/${started.takeover.id}`)).json();
    assert.equal(ticket.status, 'expired');
    assert.match(ticket.reason, /超时/);
    const claim = await fetch(env.service.url + started.takeover.claimPath);
    assert.equal(claim.status, 409);
    assert.match((await claim.json()).error, /超时/);
    const session = await (await fetch(`${env.service.url}/sessions/${started.session}`)).json();
    assert.equal(session.state, 'failed');
    assert.match(session.reason, /超时/);
    const { events } = await (await fetch(`${env.service.url}/ledger?session=${started.session}`)).json();
    assert.ok(events.some(e => e.action === 'takeover.expired' && e.actor === 'system'));
  } finally { await env.cleanup(); }
});

test('多个采集工作者不能同时控制同一会话', async () => {
  const env = await setup();
  try {
    const first = await startPaused(env.service);
    const second = await startPaused(env.service);
    const denied = await post(env.service, `/sessions/${first.session}/cancel`, { worker: second.worker });
    assert.equal(denied.status, 403);
    const anonymous = await post(env.service, `/sessions/${first.session}/cancel`, { worker: 'nobody' });
    assert.equal(anonymous.status, 403);
    const ok = await post(env.service, `/sessions/${first.session}/cancel`, { worker: first.worker });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).state, 'cancelled');
    const ticket = await (await fetch(`${env.service.url}/takeovers/${first.takeover.id}`)).json();
    assert.equal(ticket.status, 'aborted');
    const other = await (await fetch(`${env.service.url}/sessions/${second.session}`)).json();
    assert.equal(other.state, 'paused', '取消一个会话不得影响另一会话');
  } finally { await env.cleanup(); }
});

test('人工切换机构后恢复被拒绝并留下原因', async () => {
  const env = await setup();
  try {
    const started = await startPaused(env.service);
    const auth = await claim(env.service, started);
    const input = await post(env.service, `/takeovers/${started.takeover.id}/input`, { auth, kind: 'click', selector: '#switch' });
    assert.equal(input.status, 200, JSON.stringify(await input.json()));
    const done = await post(env.service, `/takeovers/${started.takeover.id}/complete`, { auth });
    assert.equal(done.status, 200);
    const result = await done.json();
    assert.equal(result.status, 'failed');
    assert.match(result.reason, /机构已切换/);
    const session = await (await fetch(`${env.service.url}/sessions/${started.session}`)).json();
    assert.equal(session.state, 'failed');
    assert.match(session.reason, /机构已切换/);
    const { events } = await (await fetch(`${env.service.url}/ledger?session=${started.session}`)).json();
    assert.ok(events.some(e => e.action === 'resume.rejected' && e.actor === 'system' && /机构/.test(e.detail.reason)));
    assert.ok(events.some(e => e.action === 'operator.input' && e.actor === 'human'));
  } finally { await env.cleanup(); }
});

test('人工退出账号后恢复被拒绝并留下原因', async () => {
  const env = await setup();
  try {
    const started = await startPaused(env.service);
    const auth = await claim(env.service, started);
    await post(env.service, `/takeovers/${started.takeover.id}/input`, { auth, kind: 'click', selector: '#close-context' });
    const result = await (await post(env.service, `/takeovers/${started.takeover.id}/complete`, { auth })).json();
    assert.equal(result.status, 'failed');
    assert.match(result.reason, /账号已变更/);
  } finally { await env.cleanup(); }
});

test('确认未完成时不允许恢复采集', async () => {
  const env = await setup();
  try {
    const started = await startPaused(env.service);
    const auth = await claim(env.service, started);
    const result = await (await post(env.service, `/takeovers/${started.takeover.id}/complete`, { auth })).json();
    assert.equal(result.status, 'failed');
    assert.match(result.reason, /确认尚未完成/);
  } finally { await env.cleanup(); }
});

test('旧接管入口再次提交被拒绝', async () => {
  const env = await setup();
  try {
    const started = await startPaused(env.service);
    const auth = await claim(env.service, started);
    await post(env.service, `/takeovers/${started.takeover.id}/input`, { auth, kind: 'click', selector: '#switch' });
    const first = await post(env.service, `/takeovers/${started.takeover.id}/complete`, { auth });
    assert.equal(first.status, 200);
    const again = await post(env.service, `/takeovers/${started.takeover.id}/complete`, { auth });
    assert.equal(again.status, 409);
    assert.match((await again.json()).error, /机构已切换/);
    const input = await post(env.service, `/takeovers/${started.takeover.id}/input`, { auth, kind: 'click', selector: '#switch' });
    assert.equal(input.status, 409);
    const view = await fetch(`${env.service.url}/takeovers/${started.takeover.id}/view?key=${auth}`);
    assert.equal(view.status, 409);
  } finally { await env.cleanup(); }
});

test('进程重启后旧工单标记浏览器丢失并要求重新开始会话', async () => {
  const env = await setup();
  const started = await startPaused(env.service);
  await env.service.close();
  const service2 = await startService({ source: env.fixture.url, directory: env.directory, takeoverTtlMs: 5000 });
  try {
    const ticket = await (await fetch(`${service2.url}/takeovers/${started.takeover.id}`)).json();
    assert.equal(ticket.status, 'browser-lost');
    assert.match(ticket.reason, /重新开始会话/);
    const claim = await fetch(service2.url + started.takeover.claimPath);
    assert.equal(claim.status, 409);
    assert.match((await claim.json()).error, /重新开始会话/);
    const complete = await post(service2, `/takeovers/${started.takeover.id}/complete`, { auth: 'whatever' });
    assert.equal(complete.status, 409);
    assert.match((await complete.json()).error, /重新开始会话/);
    const missing = await fetch(`${service2.url}/sessions/${started.session}`);
    assert.equal(missing.status, 404);
    const { events } = await (await fetch(`${service2.url}/ledger?session=${started.session}`)).json();
    assert.ok(events.some(e => e.action === 'takeover.browser-lost' && e.actor === 'system'));
  } finally {
    await service2.close();
    await env.fixture.close();
    await rm(env.directory, { recursive: true, force: true });
  }
});

test('人工放弃接管后会话安全结束', async () => {
  const env = await setup();
  try {
    const started = await startPaused(env.service);
    const auth = await claim(env.service, started);
    const abort = await post(env.service, `/takeovers/${started.takeover.id}/abort`, { auth, reason: '经办人发现账号不符' });
    assert.equal(abort.status, 200);
    assert.equal((await abort.json()).status, 'aborted');
    const session = await (await fetch(`${env.service.url}/sessions/${started.session}`)).json();
    assert.equal(session.state, 'failed');
    assert.match(session.reason, /账号不符/);
    const { events } = await (await fetch(`${env.service.url}/ledger?session=${started.session}`)).json();
    assert.ok(events.some(e => e.action === 'takeover.aborted' && e.actor === 'human'));
  } finally { await env.cleanup(); }
});

test('操作视图与输入转发只在接管期内可用', async () => {
  const env = await setup({ ttl: 400 });
  try {
    const started = await startPaused(env.service);
    const early = await fetch(`${env.service.url}/takeovers/${started.takeover.id}/view?key=nope`);
    assert.equal(early.status, 409);
    const auth = await claim(env.service, started);
    const view = await fetch(`${env.service.url}/takeovers/${started.takeover.id}/view?key=${auth}`);
    assert.equal(view.status, 200);
    assert.match(view.headers.get('content-type'), /image\/jpeg/);
    assert.ok((await view.arrayBuffer()).byteLength > 500);
    const operate = await fetch(`${env.service.url}/takeovers/${started.takeover.id}/operate?key=${auth}`);
    assert.equal(operate.status, 200);
    assert.match(await operate.text(), /人工接管操作台/);
    const badKey = await post(env.service, `/takeovers/${started.takeover.id}/input`, { auth: 'bad', kind: 'click', x: 1, y: 1 });
    assert.equal(badKey.status, 403);
    await sleep(800);
    const late = await post(env.service, `/takeovers/${started.takeover.id}/input`, { auth, kind: 'click', x: 1, y: 1 });
    assert.equal(late.status, 409);
  } finally { await env.cleanup(); }
});

test('台账区分自动与人工动作且不泄露页面人员资料', async () => {
  const env = await setup();
  try {
    const started = await startPaused(env.service);
    const auth = await claim(env.service, started);
    const secret = '敏感备注-张三-' + Math.random().toString(36).slice(2);
    const typed = await post(env.service, `/takeovers/${started.takeover.id}/input`, { auth, kind: 'type', text: secret });
    assert.equal(typed.status, 200);
    await post(env.service, `/takeovers/${started.takeover.id}/input`, { auth, kind: 'click', selector: '#switch' });
    await post(env.service, `/takeovers/${started.takeover.id}/complete`, { auth });
    const { events } = await (await fetch(`${env.service.url}/ledger?session=${started.session}`)).json();
    const actors = new Set(events.map(e => e.actor));
    assert.ok(actors.has('robot') && actors.has('human') && actors.has('system'));
    const typeEvent = events.find(e => e.action === 'operator.input' && e.detail.kind === 'type');
    assert.equal(typeEvent.actor, 'human');
    assert.equal(typeEvent.detail.length, secret.length);
    assert.ok(!('text' in typeEvent.detail), '台账不得记录输入文本');
    const raw = await readFile(join(env.directory, 'ledger.jsonl'), 'utf8');
    assert.ok(!raw.includes(secret), '台账文件不得包含人工输入的说明内容');
    assert.ok(!raw.includes('已确认资料'), '台账文件不得包含页面人员资料');
    const ticketRaw = await readFile(join(env.directory, 'takeovers', started.takeover.id + '.json'), 'utf8');
    assert.ok(!ticketRaw.includes(secret));
    assert.ok(!ticketRaw.includes('token='), '工单文件不得保存凭据原文');
  } finally { await env.cleanup(); }
});
