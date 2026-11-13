import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture } from '../fixtures/source.mjs';
import { startService } from '../src/service.mjs';

// 人工接管演练：启动来源与接入服务，发起一次采集；遇到人工确认页时打印一次性接管入口，
// 由真实经办人在浏览器中打开并手动完成确认，随后采集从停止点继续。
const directory = process.env.DATA_DIR ?? await mkdtemp(join(tmpdir(), 'takeover-rehearsal-'));
const fixture = process.env.SOURCE_URL ? { url: process.env.SOURCE_URL, close: async () => {} } : await startFixture();
const ttl = Number(process.env.TAKEOVER_TTL_MS ?? 600000);
const service = await startService({
  source: fixture.url,
  directory,
  takeoverTtlMs: ttl,
  headless: process.env.HEADFUL !== '1',
});
const key = process.env.RECEIPT_KEY ?? 'rehearsal';

async function shutdown(code) {
  await service.close();
  await fixture.close();
  process.exit(code);
}
process.once('SIGINT', () => shutdown(130));
process.once('SIGTERM', () => shutdown(143));

const response = await fetch(service.url + '/sessions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ key }),
});
const started = await response.json();
if (!response.ok) {
  console.error('采集启动失败：', started);
  await shutdown(1);
}

if (started.status === 'completed') {
  console.log('来源无需人工确认，采集已完成：');
  console.log(JSON.stringify(started.receipt, null, 2));
  await shutdown(0);
}

console.log('采集已在人工确认页暂停，等待经办人接管。');
console.log(`接管入口（${Math.round(ttl / 1000)} 秒内有效，仅可领取一次，请勿转发）：`);
console.log(`  ${service.url}${started.takeover.claimPath}`);
console.log('经办人在该页面中手动完成确认并点击“完成确认”后，采集将从停止点继续。');

const interval = setInterval(poll, 2000);
async function poll() {
  try {
    const session = await (await fetch(`${service.url}/sessions/${started.session}`)).json();
    if (!['completed', 'failed', 'cancelled', 'lost'].includes(session.state)) return;
    clearInterval(interval);
    console.log(`会话结束：${session.state}${session.reason ? `（${session.reason}）` : ''}`);
    const { events } = await (await fetch(`${service.url}/ledger?session=${started.session}`)).json();
    console.log('台账（actor 区分自动与人工动作）：');
    for (const event of events) {
      const detail = Object.keys(event.detail ?? {}).length ? ' ' + JSON.stringify(event.detail) : '';
      console.log(`  [${event.time}] ${event.actor} ${event.action}${detail}`);
    }
    if (session.state === 'completed') {
      const receipt = await (await fetch(`${service.url}/receipts/${key}`)).json();
      console.log('接收回执：', JSON.stringify(receipt.value, null, 2));
    }
    await shutdown(session.state === 'completed' ? 0 : 2);
  } catch (error) {
    console.error('轮询失败：', error.message);
  }
}
