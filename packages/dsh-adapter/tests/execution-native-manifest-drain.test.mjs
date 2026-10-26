/** Explicit fault at the original read primitive boundary. Product Service,
 * pool, queue and JSON are real; the additional physical-drain hold is a contract,
 * not a claim about SDK/provider physical behavior. No production test hook.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { build } from 'esbuild';

async function host(t) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-manifest-drain-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = resolve('packages/dsh-adapter/dist/execution-service.js');
  const require = createRequire(resolve('packages/dsh-adapter/package.json'));
  const bundle = join(root, 'contract.mjs');
  await build({
    entryPoints: [resolve('packages/dsh-adapter/tests/execution-native-manifest-fixture.mjs')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: {
      js: "import { createRequire as __contractRequire } from 'node:module'; const require = __contractRequire(import.meta.url);",
    },
    alias: {
      '@zhuma/agent-core': resolve('packages/agent-core/dist/index.js'),
      '@zhuma/context': resolve('packages/context/dist/index.js'),
    },
    plugins: [
      {
        name: 'explicit-reader-drain-contract',
        setup(builder) {
          builder.onResolve({ filter: /^@deepseek-ai\// }, (args) => ({
            path: require.resolve(args.path),
            external: true,
          }));
          builder.onLoad({ filter: /execution-service\.js$/ }, async (args) => {
            if (args.path !== service) return undefined;
            const original = await readFile(service, 'utf8');
            const call = 'const read = readVerifiedArtifactFile({';
            assert.equal(original.split(call).length, 2, 'one exact original primitive call');
            return {
              contents: original.replace(
                call,
                'const read = globalThis.__zhumaManifestReadContract(readVerifiedArtifactFile, {',
              ),
              loader: 'js',
            };
          });
        },
      },
    ],
  });
  const { openManifestContract } = await import(pathToFileURL(bundle).href);
  const h = await openManifestContract(join(root, 'state'));
  const drain = Promise.withResolvers(),
    result = Promise.withResolvers();
  globalThis.__zhumaManifestReadContract = (original, input) => {
    assert.equal(input.collect, false, 'fixed-result verification must not buffer entire files');
    const read = original(input);
    return {
      result: read.result.then(
        (value) => {
          result.resolve('success');
          return value;
        },
        (error) => {
          result.resolve('rejected');
          throw error;
        },
      ),
      drain: Promise.all([read.drain, drain.promise]).then(() => undefined),
    };
  };
  t.after(async () => {
    drain.resolve();
    await h.close();
    delete globalThis.__zhumaManifestReadContract;
    await rm(root, { recursive: true, force: true });
  });
  return { ...h, drain, result };
}

for (const outcome of ['success', 'rejected', 'revoked']) {
  test(`manifest drain contract: ${outcome} result cannot commit or release its shared slot before actual drain`, async (t) => {
    const h = await host(t);
    if (outcome === 'rejected') h.controls.bytesOverride = new Uint8Array(h.bytes.length).fill(1);
    const before = JSON.stringify(h.read());
    let settled = false;
    const pending = h.service
      .submitNativeFixedResult(h.request, h.submission(), h.opened.grant, h.ref)
      .finally(() => {
        settled = true;
      });
    assert.equal(await h.result.promise, outcome === 'rejected' ? 'rejected' : 'success');
    for (let i = 0; i < 3; i++) await setImmediate();
    assert.equal(settled, false, 'a successful logical read is insufficient for a durable result');
    assert.equal(h.service.fileReadResources.size, 1, 'original shared slot remains owned');
    assert.equal(JSON.stringify(h.read()), before);
    assert.equal(h.counters.nodes, 0);
    assert.equal(
      (await h.service.enqueue(async () => ({ ok: true, value: 'responsive' }))).value,
      'responsive',
    );
    if (outcome === 'success') {
      const peers = await Promise.all(
        Array.from({ length: 7 }, () =>
          h.service.verifyOwnedFileBytes(
            h.record,
            new AbortController().signal,
            () => {},
            false,
            true,
          ),
        ),
      );
      assert.equal(
        h.service.fileReadResources.size,
        8,
        'the fixed-result reader consumes the original shared eight-slot quota',
      );
      await assert.rejects(
        h.service.verifyOwnedFileBytes(
          h.record,
          new AbortController().signal,
          () => {},
          false,
          true,
        ),
        (error) => error.code === 'quota-exceeded',
      );
      for (const peer of peers) peer.release();
      assert.equal(
        h.service.fileReadResources.size,
        8,
        'logical releases cannot free undrained slots',
      );
    }
    if (outcome === 'revoked') h.member.abort();
    h.drain.resolve();
    const value = await pending;
    assert.equal(value.ok, outcome === 'success', JSON.stringify(value));
    if (outcome === 'success') assert.equal(h.read().artifactVersions.length, 1);
    else assert.equal(JSON.stringify(h.read()), before);
    assert.equal(h.service.fileReadResources.size, 0);
  });
}
