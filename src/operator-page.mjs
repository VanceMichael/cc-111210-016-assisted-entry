const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
));

// 本地操作台：人工在受限视图中亲自完成确认。系统只转发人工输入，绝不代答确认内容。
export function operatorPage({ ticket, key }) {
  const { id, expiresAt, context } = ticket;
  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<title>人工接管操作台</title>
<style>
  body { font: 16px/1.5 sans-serif; margin: 24px; max-width: 1320px; }
  #view { border: 2px solid #444; cursor: crosshair; max-width: 100%; display: block; }
  .panel { margin: 12px 0; }
  button { padding: 8px 16px; margin-right: 8px; }
  input[type=text] { padding: 8px; width: 320px; }
  #log { white-space: pre-wrap; background: #f2f2f2; padding: 12px; min-height: 48px; }
  .warn { color: #a00; }
</style>
<body data-ticket="${escapeHtml(id)}" data-key="${escapeHtml(key)}" data-expires="${escapeHtml(expiresAt)}">
<h1>人工接管操作台</h1>
<p>工单 <code>${escapeHtml(id)}</code> · 状态 <b id="state"></b> · 截止 <span id="deadline"></span>（剩余 <span id="left"></span> 秒）</p>
<p>暂停时上下文：账号 <b>${escapeHtml(context.account)}</b> · 机构 <b>${escapeHtml(context.institution)}</b>。
请核对无误后在下方页面视图中手动完成确认；确认动作必须由人完成，系统不会代答。
若账号或机构不符、页面已关闭，请放弃接管。</p>
<div class="panel"><img id="view" alt="页面视图加载中"></div>
<div class="panel">
  <input type="text" id="text" placeholder="在此输入文本，发送后转发到页面（内容不记录）">
  <button id="send">发送文本</button>
  <button id="enter">回车</button>
  <button id="tab">Tab</button>
</div>
<div class="panel">
  <button id="finish">完成确认，恢复采集</button>
  <button id="abort" class="warn">放弃接管</button>
</div>
<pre id="log"></pre>
<script>
const root = document.body.dataset;
const ticket = root.ticket;
const key = root.key;
const view = document.getElementById('view');
const log = message => { document.getElementById('log').textContent += message + '\\n'; };
const post = async (action, body) => {
  const response = await fetch('/takeovers/' + ticket + '/' + action, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ auth: key, ...body }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) log('错误：' + (data.error || response.status));
  return data;
};
const refresh = () => { view.src = '/takeovers/' + ticket + '/view?key=' + encodeURIComponent(key) + '&t=' + Date.now(); };
view.addEventListener('click', async event => {
  const box = view.getBoundingClientRect();
  const x = Math.round((event.clientX - box.left) * view.naturalWidth / box.width);
  const y = Math.round((event.clientY - box.top) * view.naturalHeight / box.height);
  await post('input', { kind: 'click', x, y });
  setTimeout(refresh, 300);
});
document.getElementById('send').onclick = async () => {
  const input = document.getElementById('text');
  if (!input.value) return;
  await post('input', { kind: 'type', text: input.value });
  input.value = '';
  setTimeout(refresh, 300);
};
document.getElementById('enter').onclick = async () => { await post('input', { kind: 'press', press: 'Enter' }); setTimeout(refresh, 300); };
document.getElementById('tab').onclick = async () => { await post('input', { kind: 'press', press: 'Tab' }); setTimeout(refresh, 300); };
document.getElementById('finish').onclick = async () => {
  const result = await post('complete', {});
  if (result.status === 'completed') log('核对通过，采集已从停止点继续并完成。');
  else if (result.status === 'failed') log('接管已安全结束：' + result.reason + '。请让采集方重新开始会话。');
  poll();
};
document.getElementById('abort').onclick = async () => {
  const result = await post('abort', {});
  if (result.status) log('已放弃接管：' + (result.reason || ''));
  poll();
};
const poll = async () => {
  const response = await fetch('/takeovers/' + ticket);
  const data = await response.json();
  document.getElementById('state').textContent = data.status + (data.reason ? '（' + data.reason + '）' : '');
  const left = Math.max(0, Math.round((Date.parse(data.expiresAt) - Date.now()) / 1000));
  document.getElementById('left').textContent = left;
  const terminal = ['completed', 'failed', 'expired', 'aborted', 'browser-lost'].includes(data.status);
  for (const id of ['finish', 'abort', 'send', 'enter', 'tab']) document.getElementById(id).disabled = terminal;
  return terminal;
};
document.getElementById('deadline').textContent = new Date(root.expires).toLocaleString();
refresh();
setInterval(refresh, 1500);
setInterval(poll, 2000);
poll();
</script>
</body>
</html>`;
}
