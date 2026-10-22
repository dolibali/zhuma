#!/usr/bin/env node
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const home = process.env.DSH_HOME ?? process.cwd();
const mode = readMode(home);
writeFileSync(path.join(home, 'zhuma-pid'), String(process.pid), 'utf8');
writeFileSync(path.join(home, 'zhuma-argv.json'), JSON.stringify(process.argv.slice(2)), 'utf8');
writeFileSync(
  path.join(home, 'zhuma-env-keys.json'),
  JSON.stringify(Object.keys(process.env).sort()),
  'utf8',
);
mkdirSync(path.join(home, 'decoy-skills', 'skill-evil'), { recursive: true });
writeFileSync(
  path.join(home, 'decoy-skills', 'skill-evil', 'SKILL.md'),
  '---\nid: skill-evil\nversion: evil-1\n---\n',
  'utf8',
);
writeFileSync(path.join(home, 'zhuma-visible.json'), JSON.stringify(visibleCatalog(home)), 'utf8');

let prompted = false;
let buffer = '';
process.stdin.setEncoding('utf8');
process.on('SIGTERM', () => {
  if (!prompted) {
    process.exit(0);
    return;
  }
  const event = { type: 'turn/end', reason: { kind: 'aborted' } };
  appendLog(event);
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: 'stopped', event } })}\n`,
    () => process.exit(0),
  );
  setTimeout(() => process.exit(0), 50);
});
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length > 0) handle(line);
    newline = buffer.indexOf('\n');
  }
});

function handle(line) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    if (mode === 'crash-init') process.exit(1);
    if (mode === 'hang-init') return;
    if (mode === 'noise') process.stdout.write('not-json\n');
    reply(message.id, { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } });
    return;
  }
  if (message.method === 'session/resume') {
    const history = readLog();
    writeFileSync(path.join(home, 'zhuma-history.json'), JSON.stringify(history), 'utf8');
    reply(message.id, {});
    return;
  }
  if (message.method === 'session/prompt') {
    if (mode === 'hang-prompt') return;
    if (mode === 'stderr-leak' || mode === 'hold-after-messageId') {
      process.stderr.write(`${process.env.ZHUMA_MODEL_API_KEY ?? ''}\n`);
    }
    const stored = admit(message.params?.contentBlocks ?? []);
    writeFileSync(path.join(home, 'zhuma-prompt.json'), JSON.stringify(stored), 'utf8');
    appendLog({ type: 'user', content: stored });
    if (mode === 'no-message-id') {
      reply(message.id, {});
      return;
    }
    reply(message.id, { messageId: 'msg-1' });
    prompted = true;
    if (mode === 'hold-after-messageId') {
      waitRelease(() => finishTurn());
      return;
    }
    finishTurn();
  }
}

function finishTurn() {
  if (mode === 'empty') {
    emit('assistant/message', { content: [{ type: 'text', text: '   ' }] });
  } else if (mode === 'tools') {
    emit('assistant/message', { content: [{ type: 'tool-call', id: 'call-1' }] });
  } else if (mode === 'error') {
    emit('turn/end', { reason: { kind: 'error' } });
    exitSoon();
    return;
  } else {
    emit('assistant/message', { content: [{ type: 'text', text: '桩回复' }] });
  }
  emit('turn/end', { reason: { kind: 'completed' } });
  exitSoon();
}

function exitSoon() {
  process.stdout.write('', () => process.exit(0));
}

function emit(type, data) {
  const event = { type, ...data };
  appendLog(event);
  notify('session.event', { sessionId: 'live', event });
}

function admit(blocks) {
  const stored = [];
  let index = 0;
  for (const block of blocks) {
    if (block?.type === 'image') {
      const bytes = Buffer.from(String(block.data ?? ''), 'base64');
      const id = `image-${index}`;
      const dir = path.join(home, 'zhuma-attachments');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, id), bytes);
      stored.push({ type: 'image', attachmentId: id });
      index += 1;
    } else {
      stored.push(block);
    }
  }
  return stored;
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function notify(method, params) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

function waitRelease(done) {
  const file = path.join(home, 'zhuma-release');
  const timer = setInterval(() => {
    try {
      readFileSync(file);
      clearInterval(timer);
      done();
    } catch {
      // 仍在等待页面或测试放开这一轮。
    }
  }, 20);
}

function appendLog(entry) {
  const file = path.join(home, 'zhuma-session.jsonl');
  const previous = exists(file) ? readFileSync(file, 'utf8') : '';
  writeFileSync(file, `${previous}${JSON.stringify(entry)}\n`, 'utf8');
}

function readLog() {
  const file = path.join(home, 'zhuma-session.jsonl');
  if (!exists(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function exists(file) {
  try {
    readFileSync(file);
    return true;
  } catch {
    return false;
  }
}

function readMode(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'zhuma-mode.json'), 'utf8')).mode ?? 'ok';
  } catch {
    return 'ok';
  }
}

function visibleCatalog(dir) {
  const grant = JSON.parse(readFileSync(path.join(dir, 'zhuma-grant.json'), 'utf8'));
  const patch = readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8');
  const skills = [...grant.skills];
  const sections = patch.split(/\n\s*- id:/);
  const office = sections.find((section) => section.includes('skill-office')) ?? '';
  if (!/disabled:\s*true/.test(office)) skills.push({ id: 'skill-office', version: 'bundled' });
  const filesystem = sections.find((section) => section.includes('skill-filesystem')) ?? '';
  if (!/includeDefaultRoots:\s*false/.test(filesystem)) {
    const decoy = path.join(dir, 'decoy-skills');
    for (const name of readdirSync(decoy)) {
      const text = readFileSync(path.join(decoy, name, 'SKILL.md'), 'utf8');
      const version = text.match(/version:\s*(\S+)/)?.[1] ?? '';
      skills.push({ id: name, version });
    }
  }
  return { skills, mcp: grant.mcp };
}
