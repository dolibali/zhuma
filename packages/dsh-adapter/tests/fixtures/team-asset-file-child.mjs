import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local';
import { TeamAssetFileBytes } from '../../dist/team-asset-file.js';

// A real original attachment provider in two fresh OS processes. The metadata
// file is a controlled carrier fixture, not a substitute asset authority store.
const [operation, root, metadata] = process.argv.slice(2);
const ctx = new Context(),
  fiber = ctx.plugin(LocalAttachmentStore, { dshHome: root });
await fiber;
const files = new TeamAssetFileBytes(ctx.attachments);
const grant = { signal: new AbortController().signal, assertCurrent() {} };
try {
  if (operation === 'save') {
    const data = Buffer.from('新的团队资料进程。A汉😀BC\n固定字节不是任务。');
    const sha256 = createHash('sha256').update(data).digest('hex');
    const blob = await files.save(
      { name: 'team-data.txt', mediaType: 'text/plain', byteSize: data.length, sha256 },
      (async function* () {
        yield data.subarray(0, 7);
        yield data.subarray(7);
      })(),
      grant,
    );
    await writeFile(metadata, JSON.stringify(blob));
    process.stdout.write(JSON.stringify({ phase: 'saved', sha256, bytes: data.length }));
  } else if (operation === 'read') {
    const blob = JSON.parse(await readFile(metadata, 'utf8'));
    const data = await files.read(blob, grant);
    process.stdout.write(
      JSON.stringify({
        phase: 'reopened',
        sha256: createHash('sha256').update(data).digest('hex'),
        bytes: data.length,
      }),
    );
  } else throw Error('Unknown fixture operation');
} finally {
  await files.close();
  await fiber.dispose();
}
