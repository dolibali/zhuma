/** Original Cordis logging with a minimal owner transport port; no CLI/model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openHostCodeArtsSetup } from '../dist/host-codearts-setup.js';

test(
  'CodeArts fixed stage is visible through the actual default-level logger',
  {
    skip: !process.env.ZHUMA_CODEARTS_LOADER_MODULE,
  },
  async (t) => {
    const sdk = new URL(
      '../../../',
      pathToFileURL(resolve(process.env.ZHUMA_CODEARTS_LOADER_MODULE)),
    );
    const { Context } = await import(new URL('vendor/cordis/lib/index.js', sdk));
    const ctx = new Context(),
      records = [],
      routes = new Map();
    t.after(() => ctx.fiber.dispose());
    // Deliberately no levels override: this is the normal original default.
    ctx.logger.exporter({
      export: (record) => records.push({ type: record.type, args: record.args }),
    });
    ctx.logger.warn('original warn level is hidden by the default exporter');
    assert.deepEqual(
      records,
      [],
      'distinguishes the old diagnostic which the original logger filters',
    );
    ctx.provide('connection', {
      requestRejection: () => undefined,
      admit: () => ({ peer: { principal: { kind: 'owner' } } }),
      fetch: {
        register: (route) => {
          routes.set(route.path, route);
          return () => routes.delete(route.path);
        },
      },
    });
    const setup = openHostCodeArtsSetup(ctx);
    t.after(() => setup.close());
    const response = await routes.get('/api/zhuma-codearts/configure').fetch(
      new Request('http://local.invalid/api/zhuma-codearts/configure', {
        method: 'POST',
        headers: {
          origin: 'http://local.invalid',
          host: 'local.invalid',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ command: 'codearts' }),
      }),
    );
    assert.equal(response.status, 409);
    assert.deepEqual(
      await response.json(),
      { ok: false, code: 'unavailable' },
      'stage is server-only; response has no added field',
    );
    assert.deepEqual(records, [{ type: 'error', args: ['CodeArts setup unavailable at editor.'] }]);
  },
);
