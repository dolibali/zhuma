const state = {
  view: null,
  snapshot: null,
  localError: null,
  disconnected: false,
  skillQuery: '',
  mcpQuery: '',
  skillIds: [],
  mcpIds: [],
};

let pollTimer = 0;
let pollDelay = 0;
let busy = false;

const thread = document.querySelector('#thread');
const aside = document.querySelector('#config');
const banner = document.querySelector('#banner');
const composer = document.querySelector('#composer');
const message = document.querySelector('#message');
const primary = document.querySelector('#primary');
const primaryReason = document.querySelector('#primary-reason');
const stopButton = document.querySelector('#stop');
const intentWrap = document.querySelector('#intent-wrap');
const intent = document.querySelector('#intent');
const intentNote = document.querySelector('#intent-note');
const attachmentList = document.querySelector('#attachment-list');
const fileInput = document.querySelector('#file');
const draftDialog = document.querySelector('#draft-dialog');
const draftForm = document.querySelector('#draft-form');
const draftText = document.querySelector('#draft-text');

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function taskMode() {
  return new URLSearchParams(location.search).get('view') === 'task';
}

function adopt(payload, fromUser) {
  state.snapshot = payload.snapshot;
  state.view = payload.view;
  state.skillIds = payload.view.skills.filter((item) => item.selected).map((item) => item.id);
  state.mcpIds = payload.view.mcp.filter((item) => item.selected).map((item) => item.id);
  if (fromUser) {
    state.localError = payload.ok === false && !payload.view?.error ? payload : null;
  }
  state.disconnected = false;
  render();
  schedule();
}

async function load() {
  const response = await fetch('/api/workspace');
  const payload = await response.json();
  adopt(payload, false);
}

function schedule() {
  const delay = state.view?.poll ? 250 : 1500;
  if (pollTimer !== 0 && pollDelay === delay) return;
  if (pollTimer !== 0) window.clearInterval(pollTimer);
  pollDelay = delay;
  pollTimer = window.setInterval(() => {
    void refresh();
  }, delay);
}

async function refresh() {
  if (busy) return;
  try {
    const response = await fetch('/api/workspace');
    if (!response.ok) throw new Error('工作区没有响应');
    const payload = await response.json();
    adopt(payload, false);
  } catch {
    state.disconnected = true;
    render();
  }
}

async function post(pathname, body) {
  if (busy) return { ok: false };
  busy = true;
  render();
  try {
    const response = await fetch(pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const payload = await response.json();
    adopt(payload, true);
    return payload;
  } catch {
    state.disconnected = true;
    state.localError = {
      objectLabel: '工作区服务',
      reason: '页面与服务断开。当前显示的是断开前的事实。',
      nextStep: '保留当前页面。不要把这次失败看成运行已完成。',
    };
    render();
    return { ok: false };
  } finally {
    busy = false;
    render();
  }
}

function render() {
  const view = state.view;
  if (!view) return;
  const task = taskMode();
  document.querySelector('#crumb').textContent = view.taskCrumb;
  document.querySelector('#page-title').textContent = task ? view.taskTitle : view.pageTitle;
  document.querySelector('#back-link').textContent = view.backLabel;
  document.querySelector('#back-link').setAttribute('href', view.backHref);
  const status = document.querySelector('#node-status');
  status.textContent = view.nodeStatusText;
  status.dataset.status = view.nodeStatusKey;
  const notes = [
    view.banner,
    state.disconnected ? '页面与服务断开。当前显示的是断开前的事实。' : null,
    view.resumeNote,
    view.historyNote,
  ].filter(Boolean);
  banner.textContent = notes.join(' ');
  document.querySelector('#task-page').hidden = !task;
  document.querySelector('#workspace').hidden = task;
  document.querySelector('#task-heading').textContent = view.taskTitle;
  document.querySelector('#task-goal').textContent = view.taskGoal;
  document.querySelector('#task-node').textContent =
    `${view.nodeGoal}。${view.nodeStatusText}。${view.assigneeNote}`;
  if (!task) {
    renderThread();
    renderComposer();
    renderAside();
  }
}

function renderComposer() {
  const view = state.view;
  primary.textContent = view.primary.label;
  primary.disabled = busy || state.disconnected || !view.primary.enabled;
  primary.title = view.primary.disabledReason ?? '';
  primaryReason.textContent = view.primary.disabledReason ?? view.stop.disabledReason ?? '';
  stopButton.hidden = !view.stop.visible;
  stopButton.disabled = busy || state.disconnected || !view.stop.enabled;
  stopButton.title = view.stop.disabledReason ?? '停止后等待执行器回执。关闭页面不会取消运行。';
  intentWrap.hidden = !view.run;
  intentNote.hidden = !view.run;
  intentNote.textContent = view.simulated
    ? '模拟执行器不支持实时注入。发送成功不等于已应用。'
    : '发送成功不等于已应用。';
  attachmentList.innerHTML = view.attachments
    .map(
      (item) =>
        `<button class="chip" type="button" data-testid="attachment" data-remove-attachment="${escapeHtml(item.id)}" data-name="${escapeHtml(item.name)}" data-reupload="${item.reupload ? 'true' : 'false'}">${escapeHtml(item.name)}${item.reupload ? '（需重新上传）' : ''}${item.preview ? `<small>${escapeHtml(item.preview)}</small>` : ''}</button>`,
    )
    .join('');
}

function renderThread() {
  const view = state.view;
  const snapshot = state.snapshot;
  const parts = [];
  parts.push(
    `<p class="note" data-testid="next-action">下一步：${escapeHtml(view.nextAction)}</p>`,
  );
  if (view.run) {
    parts.push(
      `<p class="note" data-testid="active-run" data-run-id="${escapeHtml(view.run.id)}">第 ${view.run.attempt} 次 · ${escapeHtml(view.run.label)}${view.run.simulated ? ' · 模拟' : ''}</p>`,
    );
  } else {
    parts.push('<p class="note" data-testid="active-run" data-run-id="">没有正在执行的运行</p>');
  }
  parts.push(
    `<p class="note" data-testid="run-count" data-count="${view.runs.length}">运行记录 ${view.runs.length} 条</p>`,
  );
  for (const run of view.runs) {
    parts.push(
      `<p class="note" data-testid="run" data-run-id="${escapeHtml(run.id)}">第 ${run.attempt} 次 · ${escapeHtml(run.label)}${run.simulated ? ' · 模拟' : ''}${run.sessionDiscarded ? ' · 已丢弃' : ''}</p>`,
    );
  }
  if (view.persistenceFault) {
    parts.push(
      `<article class="error" data-testid="persistence-fault"><strong>${escapeHtml(view.persistenceFault.objectLabel)}</strong><p>${escapeHtml(view.persistenceFault.reason)}</p><p>下一步：${escapeHtml(view.persistenceFault.nextStep)}</p><button class="btn" type="button" id="rewrite-persistence" data-testid="rewrite-persistence">重写日志</button></article>`,
    );
  }
  if (state.localError && !repeatsPersistenceFault(state.localError, view.persistenceFault)) {
    parts.push(errorBlock(state.localError));
  }
  if (view.error && !repeatsPersistenceFault(view.error, view.persistenceFault)) {
    parts.push(errorBlock(view.error));
  }
  for (const block of view.blocks) {
    parts.push(`<p class="error" data-testid="context-block">${escapeHtml(block.text)}</p>`);
  }
  for (const fault of view.faults) {
    parts.push(
      `<article class="fault" data-testid="fault"><strong>${escapeHtml(fault.objectLabel)}</strong><p>${escapeHtml(fault.reason)}</p><p>下一步：${escapeHtml(fault.nextStep)}</p></article>`,
    );
  }
  for (const turn of view.turns) {
    const body = turn.generating
      ? '<p data-testid="generating">生成中</p>'
      : `<p>${escapeHtml(turn.body)}</p>`;
    parts.push(
      `<article class="turn${turn.simulated ? ' simulated' : ''}" data-testid="turn" data-role="${escapeHtml(turn.role)}"><header><strong>${escapeHtml(turn.roleLabel)}</strong>${turn.simulated ? '<span class="meta">模拟</span>' : ''}</header>${body}</article>`,
    );
  }
  for (const activity of view.activities) {
    parts.push(
      `<article class="turn simulated" data-testid="activity" data-succeeded="${activity.succeeded ? 'true' : 'false'}"><header><strong>${escapeHtml(activity.title)}</strong><span class="meta">${activity.simulated ? '模拟' : '执行器'} · ${activity.succeeded ? '成功' : '未成功'}</span></header><p>${escapeHtml(activity.detail)}</p></article>`,
    );
  }
  for (const item of view.interventions) {
    const phases = item.phases
      .map(
        (phase) =>
          `<span data-testid="phase" data-phase="${phase.id}" data-reached="${phase.reached ? 'true' : 'false'}" data-current="${phase.current ? 'true' : 'false'}">${escapeHtml(phase.label)}</span>`,
      )
      .join('');
    parts.push(
      `<article class="panel" data-testid="intervention"><p data-testid="intervention-body">${escapeHtml(item.body)}</p><div class="phase">${phases}</div>${item.notice ? `<p data-testid="intervention-notice">${escapeHtml(item.notice)}</p>` : ''}</article>`,
    );
  }
  for (const record of view.lateRecords) {
    parts.push(
      `<article class="late" data-testid="late-record"><strong>${escapeHtml(record.reason)}</strong><p>${escapeHtml(record.summary)}</p></article>`,
    );
  }
  for (const draft of view.drafts) {
    parts.push(
      `<article class="turn draft" data-testid="draft"><header><strong>产物草稿</strong></header><p>${escapeHtml(draft.text)}</p><p class="note">${escapeHtml(draft.note)}</p></article>`,
    );
  }
  if (view.citations.length > 0) {
    parts.push(
      `<p class="note" data-testid="citations">上下文引用：${view.citations.map((item) => escapeHtml(item.summary)).join('、')}</p>`,
    );
  }
  for (const request of snapshot?.recoveryRequests ?? []) {
    const label = request.kind === 'reassign' ? '改派' : '人工接回';
    parts.push(
      `<p class="note" data-testid="recovery">已记录${label}。责任人未改变，没有创建运行。</p>`,
    );
  }
  parts.push(`<p class="note" data-testid="downstream">${escapeHtml(view.downstreamText)}</p>`);
  const html = parts.join('');
  if (thread.dataset.sig === html) return;
  const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 48;
  thread.innerHTML = html;
  thread.dataset.sig = html;
  if (nearBottom) thread.scrollTop = thread.scrollHeight;
}

function repeatsPersistenceFault(error, fault) {
  if (!error || !fault) return false;
  if (error.code === 'persist-failed') return true;
  return error.reason === fault.reason && error.nextStep === fault.nextStep;
}

function errorBlock(error) {
  return `<article class="error" data-testid="error"><strong>${escapeHtml(error.objectLabel)}</strong><p>${escapeHtml(error.reason)}</p><p>下一步：${escapeHtml(error.nextStep)}</p></article>`;
}

function renderAside() {
  const view = state.view;
  if (!view || taskMode()) return;
  const html = asideMarkup(view);
  if (aside.dataset.sig === html) return;
  const active = document.activeElement;
  const focusId = active && aside.contains(active) ? active.id : '';
  const position = active && 'selectionStart' in active ? active.selectionStart : null;
  aside.innerHTML = html;
  aside.dataset.sig = html;
  if (!focusId) return;
  const next = document.getElementById(focusId);
  if (!next) return;
  next.focus();
  if (position != null && next.setSelectionRange) next.setSelectionRange(position, position);
}

function asideMarkup(view) {
  const restoring = state.snapshot?.interactionReady === false;
  const skillQuery = state.skillQuery.trim().toLowerCase();
  const mcpQuery = state.mcpQuery.trim().toLowerCase();
  const skills = view.skills.filter((item) => matches(item, skillQuery));
  const mcp = view.mcp.filter((item) => matches(item, mcpQuery));
  return [
    '<h2>本次配置</h2>',
    `<p class="note" data-testid="model">${escapeHtml(view.modelText)}</p>`,
    `<p class="note">${escapeHtml(view.modelSource)}</p>`,
    `<p class="note" data-testid="mcp-note">${escapeHtml(view.mcpNote)}</p>`,
    `<p class="note">${escapeHtml(view.assigneeNote)}</p>`,
    field(
      '专家',
      `<select id="expert" data-testid="expert">${view.experts
        .map(
          (expert) =>
            `<option value="${escapeHtml(expert.id)}"${expert.selected ? ' selected' : ''}${expert.enabled ? '' : ' disabled'}>${escapeHtml(expert.label)}${expert.summary ? `：${escapeHtml(expert.summary)}` : ''}${expert.reason ? `（${escapeHtml(expert.reason)}）` : ''}</option>`,
        )
        .join('')}</select>`,
    ),
    field(
      '执行器',
      `<select id="executor" data-testid="executor"><option value=""${view.executors.some((item) => item.selected) ? '' : ' selected'}>请选择</option>${view.executors
        .map(
          (executor) =>
            `<option value="${escapeHtml(executor.id)}"${executor.selected ? ' selected' : ''}${executor.available ? '' : ' disabled'}>${escapeHtml(executor.label)}${executor.reason ? `（${escapeHtml(executor.reason)}）` : ''}</option>`,
        )
        .join('')}</select>`,
    ),
    unavailableNotes(view),
    '<h2>Skills</h2>',
    '<input id="skill-search" data-testid="skill-search" type="search" placeholder="搜索 Skill" value="' +
      escapeHtml(state.skillQuery) +
      '" />',
    skills.map((skill) => choice('skill', skill)).join(''),
    `<div class="chips">${view.skills
      .filter((skill) => skill.selected)
      .map(
        (skill) =>
          `<button class="chip" type="button" data-testid="skill-chip" data-remove="skill" data-id="${escapeHtml(skill.id)}">${escapeHtml(skill.label)}${skill.origin ? ` · ${escapeHtml(skill.origin)}` : ''} ×</button>`,
      )
      .join('')}</div>`,
    '<h2>MCP</h2>',
    '<input id="mcp-search" data-testid="mcp-search" type="search" placeholder="搜索 MCP" value="' +
      escapeHtml(state.mcpQuery) +
      '" />',
    mcp.map((item) => choice('mcp', item)).join(''),
    `<div class="chips">${view.mcp
      .filter((item) => item.selected)
      .map(
        (item) =>
          `<button class="chip" type="button" data-testid="mcp-chip" data-remove="mcp" data-id="${escapeHtml(item.id)}">${escapeHtml(item.label)}${item.origin ? ` · ${escapeHtml(item.origin)}` : ''}${item.connection ? ` · ${escapeHtml(item.connection)}` : ''} ×</button>`,
      )
      .join('')}</div>`,
    '<h2>上下文</h2>',
    view.contextItems
      .map(
        (item) =>
          `<label class="choice"><input data-kind="context" data-testid="context" value="${escapeHtml(item.id)}" type="checkbox"${item.included ? ' checked' : ''}${item.required ? ' disabled' : ''} /><span>${escapeHtml(item.summary)}<small>${escapeHtml(item.version)}${item.required ? ' · 本轮必需' : ''}${item.blockText ? ` · ${escapeHtml(item.blockText)}` : ''}</small></span></label>`,
      )
      .join(''),
    '<h2>恢复</h2>',
    restoring
      ? '<button class="btn" type="button" id="resume" data-testid="resume">继续交互</button><p class="note">事实已装回。继续之前不会创建新运行，也不会把未结束的运行推断成完成。</p>'
      : '',
    view.verifyAbandoned
      ? '<button class="btn" type="button" id="verify" data-testid="verify">核实为执行器已断开</button>'
      : '',
    view.retry.visible
      ? `<button class="btn" type="button" id="retry" data-testid="retry"${view.retry.enabled && !busy ? '' : ' disabled'}>${escapeHtml(view.retry.label)}</button>`
      : '',
    `<button class="btn" type="button" id="reassign" data-testid="reassign"${busy ? ' disabled' : ''}>记录改派</button>`,
    `<button class="btn" type="button" id="takeover" data-testid="takeover"${busy ? ' disabled' : ''}>记录人工接回</button>`,
    '<p class="note">改派和人工接回只留下请求。责任人不变，也不会伪造一次运行。</p>',
    `<button class="btn primary" type="button" id="edit-draft" data-testid="edit-draft">保存草稿</button>`,
  ].join('');
}

function matches(item, query) {
  if (query.length === 0) return true;
  return item.label.toLowerCase().includes(query) || item.id.toLowerCase().includes(query);
}

function field(label, control) {
  return `<label class="field">${label}${control}</label>`;
}

function unavailableNotes(view) {
  const notes = [
    ...view.experts.filter((item) => item.reason).map((item) => `${item.label}：${item.reason}`),
    ...view.executors.filter((item) => item.reason).map((item) => `${item.label}：${item.reason}`),
  ];
  if (notes.length === 0) return '';
  return `<p class="note">${notes.map((note) => escapeHtml(note)).join('；')}</p>`;
}

function choice(kind, item) {
  return `<label class="choice"><input data-kind="${kind}" data-testid="${kind}" value="${escapeHtml(item.id)}" type="checkbox"${item.selected ? ' checked' : ''}${item.available ? '' : ' disabled'} /><span>${escapeHtml(item.label)}${item.origin ? ` · ${escapeHtml(item.origin)}` : ''}${item.connection ? ` · ${escapeHtml(item.connection)}` : ''}${item.reason ? `<small>${escapeHtml(item.reason)}</small>` : ''}</span></label>`;
}

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const raw = message.value;
  const text = raw.trim();
  if (text.length === 0) {
    state.localError = {
      objectLabel: '消息',
      reason: '请填写要发送的消息',
      nextStep: '写上内容后再发送。空白消息不会被看成运行完成。',
    };
    render();
    return;
  }
  const sendIntent = intentWrap.hidden ? 'new' : intent.value;
  const attachmentIds = state.view?.attachments.map((item) => item.id) ?? [];
  void post('/api/messages', {
    text,
    idempotencyKey: crypto.randomUUID(),
    intent: sendIntent,
    attachmentIds,
  }).then((result) => {
    if (result.ok && message.value === raw) message.value = '';
  });
});

message.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    if (!primary.disabled) composer.requestSubmit();
  }
});

stopButton.addEventListener('click', () => {
  void post('/api/stop');
});

fileInput.addEventListener('change', () => {
  const item = fileInput.files?.[0];
  fileInput.value = '';
  if (!item) return;
  if (item.size > 96 * 1024) {
    state.localError = {
      objectLabel: item.name,
      reason: '附件超过 96 KB',
      nextStep: '缩小文件后再上传。',
    };
    render();
    return;
  }
  void attachmentPayload(item).then((payload) => post('/api/attachments', payload));
});

function isTextUpload(file) {
  const type = file.type || '';
  if (type.startsWith('text/') || type === 'application/json') return true;
  const name = file.name.toLowerCase();
  return (
    name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.csv') || name.endsWith('.json')
  );
}

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const size = 0x8000;
  for (let index = 0; index < bytes.length; index += size) {
    binary += String.fromCharCode(...bytes.subarray(index, index + size));
  }
  return btoa(binary);
}

function attachmentPayload(file) {
  const mediaType = file.type || (isTextUpload(file) ? 'text/plain' : 'application/octet-stream');
  if (isTextUpload(file)) {
    return file.text().then((text) => ({ name: file.name, mediaType, text }));
  }
  return file.arrayBuffer().then((buffer) => ({
    name: file.name,
    mediaType,
    bytesBase64: bytesToBase64(buffer),
  }));
}

thread.addEventListener('click', (event) => {
  const button = event.target.closest('#rewrite-persistence');
  if (!button) return;
  void post('/api/persistence/rewrite');
});

attachmentList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-attachment]');
  if (!button) return;
  if (button.dataset.confirm !== 'yes') {
    button.dataset.confirm = 'yes';
    button.textContent = `确认移除 ${button.dataset.name ?? ''}`;
    return;
  }
  void post('/api/attachments/remove', { id: button.dataset.removeAttachment });
});

aside.addEventListener('input', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (target.id === 'skill-search') state.skillQuery = target.value;
  if (target.id === 'mcp-search') state.mcpQuery = target.value;
  if (target.id === 'skill-search' || target.id === 'mcp-search') renderAside();
});

aside.addEventListener('change', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
  if (busy) {
    render();
    return;
  }
  if (target.id === 'expert') {
    void post('/api/config', { expertId: target.value });
    return;
  }
  if (target.id === 'executor') {
    void post('/api/config', { executorId: target.value === '' ? null : target.value });
    return;
  }
  if (target.dataset.kind === 'skill') {
    const ids = new Set(state.skillIds);
    if (target.checked) ids.add(target.value);
    else ids.delete(target.value);
    state.skillIds = [...ids];
    void post('/api/config', { skillIds: state.skillIds });
    return;
  }
  if (target.dataset.kind === 'mcp') {
    const ids = new Set(state.mcpIds);
    if (target.checked) ids.add(target.value);
    else ids.delete(target.value);
    state.mcpIds = [...ids];
    void post('/api/config', { mcpIds: state.mcpIds });
    return;
  }
  if (target.dataset.kind === 'context') {
    void post('/api/context', { id: target.value, included: target.checked });
  }
});

aside.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.id === 'edit-draft') {
    const latest = [...(state.view?.turns ?? [])]
      .reverse()
      .find((turn) => turn.role === 'executor');
    draftText.value = state.view?.drafts.at(-1)?.text || latest?.body || '';
    draftDialog.showModal();
    return;
  }
  if (button.id === 'retry') {
    void post('/api/retry', { idempotencyKey: crypto.randomUUID() });
    return;
  }
  if (button.id === 'reassign') {
    void post('/api/recovery', { kind: 'reassign' });
    return;
  }
  if (button.id === 'takeover') {
    void post('/api/recovery', { kind: 'human-takeover' });
    return;
  }
  if (button.id === 'verify') {
    void post('/api/verify-abandoned');
    return;
  }
  if (button.id === 'resume') {
    void post('/api/resume');
    return;
  }
  if (button.dataset.remove === 'skill' || button.dataset.remove === 'mcp') {
    const key = button.dataset.remove === 'skill' ? 'skillIds' : 'mcpIds';
    const current = button.dataset.remove === 'skill' ? state.skillIds : state.mcpIds;
    void post('/api/config', { [key]: current.filter((id) => id !== button.dataset.id) });
  }
});

draftForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void post('/api/draft', { text: draftText.value }).then((result) => {
    if (result.ok) draftDialog.close();
  });
});

document.querySelector('#draft-cancel').addEventListener('click', () => {
  draftDialog.close();
});

void load();
