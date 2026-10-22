#!/usr/bin/env node
import { mkdirSync, readdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';

const home = process.env.DSH_HOME ?? process.cwd();
const mode = process.env.ZHUMA_DSH_STUB_MODE ?? 'ok';
if (mode === 'stderr-boot') {
  writeSync(2, `${process.env.ZHUMA_MODEL_API_KEY ?? ''}\n`);
  process.exit(1);
}
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
  '---\nname: skill-evil\ndescription: evil\n---\n\nevil\n',
  'utf8',
);
writeFileSync(path.join(home, 'zhuma-visible.json'), JSON.stringify(visibleCatalog(home)), 'utf8');

let prompted = false;
let resumed = false;
let acceptedPrompt = false;
let buffer = '';
let seq = 1;
process.stdin.setEncoding('utf8');
process.on('SIGTERM', () => {
  if (!prompted) {
    process.exit(0);
    return;
  }
  const event = {
    type: 'turn/end',
    seq: seq++,
    time: Date.now(),
    data: { reason: { kind: 'aborted' } },
  };
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
    if (mode === 'resume-fail') {
      errorReply(message.id, 'session missing');
      return;
    }
    resumed = true;
    const history = readLog();
    writeFileSync(path.join(home, 'zhuma-history.json'), JSON.stringify(history), 'utf8');
    reply(message.id, {});
    return;
  }
  if (message.method === 'session/prompt') {
    if (mode === 'hang-prompt') return;
    const blocks = message.params?.contentBlocks ?? [];
    const bareFile = blocks.some((block) => bareFileBlock(block));
    if (priorTurn() && !resumed && !acceptedPrompt) {
      errorReply(message.id, 'session already exists');
      return;
    }
    if (mode === 'stderr-leak' || mode === 'hold-after-messageId') {
      process.stderr.write(`${process.env.ZHUMA_MODEL_API_KEY ?? ''}\n`);
    }
    const stored = admit(blocks);
    writeFileSync(path.join(home, 'zhuma-prompt.json'), JSON.stringify(stored), 'utf8');
    appendLog({ type: 'user', content: stored });
    if (mode === 'no-message-id') {
      reply(message.id, {});
      return;
    }
    reply(message.id, { messageId: 'msg-1' });
    prompted = true;
    acceptedPrompt = true;
    if (bareFile || sessionPoisoned()) {
      emit('turn/end', {
        reason: {
          kind: 'error',
          error: {
            message: "Cannot read properties of undefined (reading 'attachmentId')",
          },
        },
      });
      exitSoon();
      return;
    }
    if (mode === 'hold-after-messageId') {
      waitRelease(() => finishTurn());
      return;
    }
    finishTurn();
  }
}

function finishTurn() {
  if (mode === 'empty') {
    emit('assistant/message', {
      message: { role: 'assistant', content: [{ type: 'text', text: '   ' }] },
    });
  } else if (mode === 'tools') {
    emit('assistant/message', {
      message: { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1' }] },
    });
  } else if (mode === 'error') {
    emit('turn/end', { reason: { kind: 'error' } });
    exitSoon();
    return;
  } else {
    emit('assistant/message', {
      message: { role: 'assistant', content: [{ type: 'text', text: '桩回复' }] },
      stream: [{ type: 'text-chunks', texts: ['桩', '回复'] }],
    });
  }
  emit('turn/end', { reason: { kind: 'completed' } });
  exitSoon();
}

function exitSoon() {
  process.stdout.write('', () => process.exit(0));
}

function emit(type, data) {
  const event = { type, seq: seq++, time: Date.now(), data };
  appendLog(event);
  notify('session.event', { sessionId: 'live', event });
}

function bareFileBlock(block) {
  if (block?.type !== 'file') return false;
  if (typeof block.attachment?.attachmentId === 'string') return false;
  if (typeof block.attachmentId === 'string') return false;
  return true;
}

function sessionPoisoned() {
  return readLog().some((entry) => containsBareFile(entry));
}

function containsBareFile(value) {
  if (Array.isArray(value)) return value.some((item) => containsBareFile(item));
  if (value !== null && typeof value === 'object') {
    if (bareFileBlock(value)) return true;
    return Object.values(value).some((item) => containsBareFile(item));
  }
  return false;
}

function admit(blocks) {
  const stored = [];
  let index = 0;
  for (const block of blocks) {
    if (bareFileBlock(block)) {
      stored.push({
        type: 'file',
        data: '',
        ...(typeof block.mimeType === 'string' ? { mimeType: block.mimeType } : {}),
        ...(typeof block.name === 'string' ? { name: block.name } : {}),
      });
      continue;
    }
    if (block?.type === 'image' || block?.type === 'file') {
      const bytes = Buffer.from(String(block.data ?? ''), 'base64');
      const id = `${block.type}-${index}`;
      const dir = path.join(home, 'zhuma-attachments');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, id), bytes);
      stored.push({
        type: block.type,
        attachmentId: id,
        ...(typeof block.name === 'string' ? { name: block.name } : {}),
        ...(typeof block.mimeType === 'string' ? { mimeType: block.mimeType } : {}),
      });
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

function errorReply(id, message) {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602, message } })}\n`,
  );
}

function priorTurn() {
  return readLog().some(
    (entry) =>
      entry.type === 'user' || entry.type === 'assistant/message' || entry.type === 'turn/end',
  );
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

function visibleCatalog(dir) {
  const patch = readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8');
  const skills = [];
  const filesystem = section(patch, 'skill-filesystem');
  const roots = [...filesystem.matchAll(/customSkillDirs:[\s\S]*?(?=\n- id:|\n- insert:|$)/g)];
  const dirs = [];
  for (const match of roots) {
    for (const found of match[0].matchAll(/- "([^"]+)"/g)) dirs.push(found[1]);
  }
  if (!/includeDefaultRoots:\s*false/.test(filesystem)) {
    dirs.push(path.join(dir, 'decoy-skills'));
  }
  for (const root of dirs) {
    let names = [];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(root, name, 'SKILL.md');
      if (!exists(file)) continue;
      const text = readFileSync(file, 'utf8');
      const parsed = readSkill(text);
      if (!parsed) continue;
      const version = text.match(/版本：(\S+)/)?.[1] ?? '';
      skills.push({ id: parsed.name, version });
    }
  }
  const office = section(patch, 'skill-office');
  if (/disabled:\s*false/.test(office)) skills.push({ id: 'skill-office', version: 'bundled' });
  const mcp = [];
  for (const match of patch.matchAll(/serverName:\s*"([^"]+)"/g)) {
    mcp.push({ id: match[1], version: 'configured' });
  }
  return { skills, mcp, toolsDisabled: disabledTools(patch) };
}

function readSkill(text) {
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!front) return null;
  const fields = {};
  for (const line of front[1].split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) return null;
    const raw = match[2];
    if (raw.startsWith('"')) {
      try {
        const value = JSON.parse(raw);
        if (typeof value !== 'string') return null;
        fields[match[1]] = value;
      } catch {
        return null;
      }
    } else if (/[:#["]/.test(raw)) {
      return null;
    } else {
      fields[match[1]] = raw.trim();
    }
  }
  if (typeof fields.name !== 'string' || fields.name.length === 0) return null;
  if (typeof fields.description !== 'string' || fields.description.length === 0) return null;
  return fields;
}

function section(patch, id) {
  const match = patch.match(new RegExp(`- id: ${id}\\n([\\s\\S]*?)(?=\\n- id:|\\n- insert:|$)`));
  return match?.[1] ?? '';
}

function disabledTools(patch) {
  const disabled = [];
  for (const match of patch.matchAll(/- id: (\S+)\n  disabled: (true|false)/g)) {
    if (match[2] === 'true') disabled.push(match[1]);
  }
  return disabled;
}
