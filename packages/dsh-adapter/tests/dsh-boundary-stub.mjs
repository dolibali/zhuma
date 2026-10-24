#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';

const home = process.env.DSH_HOME ?? process.cwd();
let mode = process.env.ZHUMA_DSH_STUB_MODE ?? 'ok';

function holdGrandchild(pidFile, script = 'setTimeout(() => {}, 8000)', stdio) {
  const child = spawn(process.execPath, ['-e', script], {
    stdio: stdio ?? ['ignore', 'ignore', 'inherit'],
    detached: true,
  });
  writeFileSync(pidFile, String(child.pid ?? ''));
  child.unref();
}

function executorPipeId(fd) {
  try {
    const stat = fstatSync(fd);
    if (!(stat.isFIFO() || stat.isSocket())) return '';
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return '';
  }
}

if (mode.startsWith('stdio-gc:')) {
  const pidFile = mode.slice('stdio-gc:'.length);
  const heldFile = `${pidFile}.held`;
  const scriptFile = `${pidFile}.mjs`;
  const expected = [0, 1, 2].map((fd) => executorPipeId(fd));
  writeFileSync(
    scriptFile,
    [
      "import { fstatSync, writeFileSync } from 'node:fs';",
      `const expected = ${JSON.stringify(expected)};`,
      'const same = (fd) => {',
      '  const id = expected[fd];',
      '  if (!id) return false;',
      '  try {',
      '    const stat = fstatSync(fd);',
      '    return (stat.isFIFO() || stat.isSocket()) && `${stat.dev}:${stat.ino}` === id;',
      '  } catch {',
      '    return false;',
      '  }',
      '};',
      `writeFileSync(${JSON.stringify(heldFile)}, same(0) && same(1) && same(2) ? '1' : '0');`,
      'setTimeout(() => {}, 8000);',
      '',
    ].join('\n'),
  );
  const grandchild = spawn(process.execPath, [scriptFile], {
    stdio: ['inherit', 'inherit', 'inherit'],
    detached: true,
  });
  writeFileSync(pidFile, String(grandchild.pid ?? ''));
  grandchild.unref();
  writeSync(1, 'stdout-held\n');
  writeSync(2, 'stderr-held\n');
  setTimeout(() => process.exit(1), 30);
  await new Promise(() => {});
}
if (mode.startsWith('stderr-gc-fail:')) {
  holdGrandchild(mode.slice('stderr-gc-fail:'.length));
  writeSync(2, 'boot crashed\n');
  setTimeout(() => process.exit(1), 30);
  await new Promise(() => {});
}
if (mode.startsWith('stderr-gc-split:')) {
  const rest = mode.slice('stderr-gc-split:'.length);
  const colon = rest.indexOf(':');
  const at = Number(rest.slice(0, colon));
  const secret = process.env.ZHUMA_MODEL_API_KEY ?? '';
  const script = [
    "const fs=require('fs');const secret=process.env.ZHUMA_MODEL_API_KEY||'';",
    `setTimeout(()=>{try{fs.writeSync(2,secret.slice(${at})+'-tail')}catch{}`,
    'setTimeout(()=>{},8000)},800)',
  ].join('');
  holdGrandchild(rest.slice(colon + 1), script);
  writeSync(2, `preface-${secret.slice(0, at)}`);
  setTimeout(() => process.exit(1), 30);
  await new Promise(() => {});
}
if (mode.startsWith('stderr-gc-ok:')) {
  holdGrandchild(mode.slice('stderr-gc-ok:'.length));
  mode = 'ok';
} else if (mode.startsWith('stderr-gc-hold:')) {
  holdGrandchild(mode.slice('stderr-gc-hold:'.length));
  mode = 'gc-hold';
}
if (mode === 'stderr-boot') {
  writeSync(2, `${process.env.ZHUMA_MODEL_API_KEY ?? ''}\n`);
  process.exit(1);
}
if (mode === 'stderr-boot-bound') {
  const emoji = '😀';
  const head = 'a'.repeat(511);
  const middle = '中'.repeat(800);
  const tail = `${'b'.repeat(1438)}\ncause: disk-full-reason`;
  const original = `${head}${emoji}${middle}${emoji}${tail}`;
  writeFileSync(path.join(home, 'zhuma-stderr-source.txt'), original, 'utf8');
  writeSync(2, original);
  process.exit(1);
}
if (mode === 'stderr-boot-prefix') {
  const secret = process.env.ZHUMA_MODEL_API_KEY ?? '';
  writeSync(2, `preface-${secret.slice(0, Math.max(0, secret.length - 1))}`);
  process.exit(1);
}
if (mode.startsWith('stderr-boot-prefix-len:')) {
  const secret = process.env.ZHUMA_MODEL_API_KEY ?? '';
  const length = Number(mode.slice('stderr-boot-prefix-len:'.length));
  writeSync(2, `preface-${secret.slice(0, length)}`);
  process.exit(1);
}
if (mode.startsWith('stderr-prefix-end:') || mode.startsWith('stderr-prefix-mid:')) {
  const secret = process.env.ZHUMA_MODEL_API_KEY ?? '';
  const mid = mode.startsWith('stderr-prefix-mid:');
  const length = Number(
    mode.slice(mid ? 'stderr-prefix-mid:'.length : 'stderr-prefix-end:'.length),
  );
  const prefix = secret.slice(0, length);
  writeSync(2, mid ? `mid-${prefix}zz\nnext\n` : `tail-${prefix}`);
  process.exit(1);
}
if (mode.startsWith('stderr-boot-split:')) {
  const secret = process.env.ZHUMA_MODEL_API_KEY ?? '';
  const at = Number(mode.slice('stderr-boot-split:'.length));
  await writeStderrChunks([`preface-${secret.slice(0, at)}`, `${secret.slice(at)}-tail`]);
  process.exit(1);
}
if (mode.startsWith('stderr-overlap:review:')) {
  const secret = process.env.ZHUMA_MODEL_API_KEY ?? '';
  const spec = mode.slice('stderr-overlap:review:'.length);
  const split = spec.indexOf(':');
  const kind = split < 0 ? spec : spec.slice(0, split);
  const how = split < 0 ? '' : spec.slice(split + 1);
  let text = '';
  if (kind === '0c') text = `${secret.slice(0, 1)}${secret.slice(0, 22)}c\n`;
  else if (kind === 'almost')
    text = `${secret.slice(0, 1)}${secret.slice(0, Math.max(0, secret.length - 1))}\n`;
  else if (kind === 'p12') text = `${secret.slice(0, 1)}${secret.slice(0, 12)}zz\n`;
  else text = `${secret.slice(0, 1)}${secret.slice(0, 7)}`;
  if (how === 'bytes') await writeStderrChunks([...text]);
  else if (how === 'split5') await writeStderrChunks([text.slice(0, 5), text.slice(5)]);
  else writeSync(2, text);
  process.exit(1);
}
if (mode.startsWith('stderr-overlap:')) {
  const secret = process.env.ZHUMA_MODEL_API_KEY ?? '';
  const spec = mode.slice('stderr-overlap:'.length);
  if (spec.startsWith('lead-split:')) {
    const lead = Number(spec.slice('lead-split:'.length));
    const text = `x ${secret.slice(0, lead)}${secret} y\n`;
    const cut = 2 + lead;
    await writeStderrChunks([text.slice(0, cut), text.slice(cut, cut + 4), text.slice(cut + 4)]);
  } else if (spec.startsWith('lead:')) {
    const lead = Number(spec.slice('lead:'.length));
    writeSync(2, `x ${secret.slice(0, lead)}${secret} y\n`);
  } else if (spec.startsWith('split:')) {
    const text = `a${secret}\n`;
    const at = Number(spec.slice('split:'.length));
    await writeStderrChunks([text.slice(0, at), text.slice(at)]);
  } else if (spec === 'bytes') {
    await writeStderrChunks(['a', ...secret, '\n']);
  } else {
    writeSync(2, `a${secret}\n`);
  }
  process.exit(1);
}
if (mode === 'stderr-boot-bytes') {
  const secret = process.env.ZHUMA_MODEL_API_KEY ?? '';
  await writeStderrChunks([...('preface-' + secret + '-tail')]);
  process.exit(1);
}
if (mode === 'stderr-boot-repeat') {
  const secret = process.env.ZHUMA_MODEL_API_KEY ?? '';
  await writeStderrChunks(['head ', secret, secret, ' gap ', secret, ' tail']);
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
    void handlePrompt(message);
    return;
  }
}

async function handlePrompt(message) {
  if (mode === 'hang-prompt') return;
  if (mode === 'stderr-ok-split') {
    const secret = process.env.ZHUMA_MODEL_API_KEY ?? '';
    const at = Math.floor(secret.length / 2);
    await writeStderrChunks([`preface-${secret.slice(0, at)}`, `${secret.slice(at)}-tail`]);
  }
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
  if (mode === 'hold-after-messageId' || mode === 'gc-hold') {
    waitRelease(() => finishTurn());
    return;
  }
  if (mode === 'stderr-cap') {
    const secret = process.env.ZHUMA_MODEL_API_KEY ?? '';
    const headLimit = 2048;
    const limit = 8192;
    const half = Math.floor(secret.length / 2);
    const reason = 'cause: disk-full-reason';
    const mark = (omitted) => `（已截断 ${omitted} 字节）`;
    const fitTail = (total) => {
      const cap = limit - headLimit;
      let omitted = Math.max(0, total - headLimit - cap);
      let tail = Math.min(cap, Math.max(0, total - headLimit));
      while (headLimit + Buffer.byteLength(mark(omitted)) + tail > limit) {
        const overflow = headLimit + Buffer.byteLength(mark(omitted)) + tail - limit;
        omitted += overflow;
        tail -= overflow;
      }
      return tail;
    };
    const headPad = headLimit - half;
    const gap1 = 4000;
    let gap2 = 1;
    for (let step = 0; step < 6; step += 1) {
      const total = headPad + secret.length + gap1 + secret.length + gap2 + 1 + reason.length;
      const tail = fitTail(total);
      const want = secret.length + gap2 + 1 + reason.length - half;
      gap2 += tail - want;
    }
    writeSync(
      2,
      `${'a'.repeat(headPad)}${secret}${'b'.repeat(gap1)}${secret}${'b'.repeat(gap2)}\n${reason}`,
    );
  }
  if (mode === 'stderr-cap-utf8') {
    const emoji = '😀';
    const head = 'a'.repeat(2047);
    const middle = '中'.repeat(4000);
    const tail = `${'b'.repeat(6093)}\ncause: disk-full-reason`;
    const original = `${head}${emoji}${middle}${emoji}${tail}`;
    writeFileSync(path.join(home, 'zhuma-stderr-source.txt'), original, 'utf8');
    writeSync(2, original);
  }
  if (mode.startsWith('stderr-head-seal:')) {
    const chunks = headSealChunks(mode.slice('stderr-head-seal:'.length));
    const original = chunks.join('');
    writeFileSync(path.join(home, 'zhuma-stderr-source.txt'), original, 'utf8');
    await writeStderrChunks(chunks);
  }
  if (mode.startsWith('stderr-surrogate:')) {
    const chunks = surrogateChunks(mode.slice('stderr-surrogate:'.length));
    const original = chunks.join('');
    writeFileSync(path.join(home, 'zhuma-stderr-source.txt'), original, 'utf8');
    await writeStderrChunks(chunks);
  }
  finishTurn();
}

function headSealChunks(kind) {
  if (kind === 'cjk-gap') return ['a'.repeat(2046), '错'.repeat(2500), '\nEND'];
  if (kind === 'emoji-gap') return ['a'.repeat(2045), '😀'.repeat(1800), '\nEND'];
  if (kind === 'cause-line') return ['磁盘'.repeat(2000), '磁盘'.repeat(2000), '\ncause: 磁盘已满'];
  return ['\nEND'];
}

function surrogateChunks(kind) {
  if (kind === 'head') return ['a'.repeat(2043) + '😀' + 'x'.repeat(36), 'y'.repeat(7000), '\nEND'];
  const count = 2048;
  const parts = 3;
  const per = Math.ceil(count / parts);
  const chunks = [];
  for (let index = 0; index < count; index += per) {
    chunks.push('😀'.repeat(Math.min(per, count - index)));
  }
  return chunks;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeStderr(text) {
  return new Promise((resolve, reject) => {
    process.stderr.write(text, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function writeStderrChunks(parts) {
  for (let index = 0; index < parts.length; index += 1) {
    if (index > 0) await delay(70);
    await writeStderr(parts[index]);
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
