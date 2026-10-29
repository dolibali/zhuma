import { parseArgs } from 'node:util';
import { writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startLocalServer, stopLocalServer } from './runtime.mjs';

const { values } = parseArgs({
  options: {
    sdk: { type: 'string' },
    plugin: { type: 'string' },
    'file-uploads': { type: 'boolean', default: false },
    'independent-reviews': { type: 'boolean', default: false },
    data: { type: 'string' },
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '3080' },
  },
});
if (!values.sdk || !values.data) throw new Error('Pass --sdk and --data explicitly');
if (!/^\d+$/u.test(values.port) || Number(values.port) > 65535) throw new Error('Invalid port');
const operatorFile = join(resolve(values.data), 'operator-url.txt');
const child = await startLocalServer({
  sdk: values.sdk,
  plugin: values.plugin,
  fileUploads: values['file-uploads'],
  independentReviews: values['independent-reviews'],
  data: values.data,
  host: values.host,
  port: Number(values.port),
});
let buffer = '';
let queued = Promise.resolve();
function output(chunk) {
  buffer += chunk.toString();
  let end;
  while ((end = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    const url = line.match(/dsh web: (https?:\/\/\S+\?token=\S+)/u)?.[1];
    if (url) {
      queued = queued.then(async () => {
        // Fresh process capability is operator-only; never print it as a member URL.
        await rm(operatorFile, { force: true });
        await writeFile(operatorFile, url + '\n', { mode: 0o600, flag: 'wx' });
        console.log(`Member entry: ${new URL('/workbench', url).href}`);
        console.log(`Private operator URL saved to ${operatorFile}`);
      });
    } else console.error(line.replace(/token=[^\s&]+/gu, 'token=[redacted]'));
  }
}
child.stdout.on('data', output);
child.stderr.on('data', output);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void stopLocalServer(child);
  });
const code = await new Promise((done, fail) => {
  child.once('exit', done);
  child.once('error', fail);
});
try {
  await queued;
} finally {
  await rm(operatorFile, { force: true });
}
process.exitCode = code ?? 1;
