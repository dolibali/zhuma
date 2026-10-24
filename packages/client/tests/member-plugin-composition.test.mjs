import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

// Compiled real plugin + registry port contract. This does not render or imitate a host sidebar.
test('member plugin composition contract: actual footer/main registrations share one owned session and preserve Settings', async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/workbench/plugin.tsx', import.meta.url))],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    loader: { '.css': 'text' },
    external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'error',
  });
  const require = createRequire(new URL('../package.json', import.meta.url));
  const module = { exports: {} };
  const reads = [];
  runInNewContext(result.outputFiles[0].text, {
    module,
    exports: module.exports,
    require,
    window: {},
    navigator: { userAgent: 'Node contract' },
    document: { createElement: () => ({ textContent: '', remove() {} }), head: { append() {} } },
    fetch: async (url) => {
      reads.push(url);
      return new Response('', { status: 401 });
    },
    AbortController,
    AbortSignal,
    Response,
    DOMException,
    URL,
    URLSearchParams,
    crypto: webcrypto,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    console,
  });
  const entries = [],
    disposers = [],
    listeners = new Set();
  let panel = { activePanelId: null },
    rpcCalls = 0;
  const layout = {
    panelInfo: {
      getSnapshot: () => panel,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    selectPanel(id) {
      assert.ok(
        id === null || entries.some(({ options }) => options.name === 'main' && options.key === id),
      );
      if (panel.activePanelId === id) return;
      panel = { activePanelId: id };
      listeners.forEach((listener) => listener());
    },
  };
  const ctx = {
    get: () => ({
      rpc: {
        call() {
          rpcCalls++;
          throw Error('Composition must not call business RPC');
        },
      },
    }),
    layout,
    theme: {
      getTheme: () => ({ preference: 'system' }),
      setTheme() {
        throw Error('No second theme action');
      },
    },
    on: () => () => {},
    effect(effect) {
      const dispose = effect();
      if (dispose) disposers.push(dispose);
    },
    slots: {
      inject(_, factory) {
        const dispose = factory();
        if (dispose) disposers.push(dispose);
      },
      register(options, component) {
        const entry = { options, component, disposed: false };
        entries.push(entry);
        return () => {
          entry.disposed = true;
        };
      },
    },
  };
  module.exports.apply(ctx);
  await new Promise((resolve) => setImmediate(resolve));
  const footers = entries.filter(({ options }) => options.name === 'sidebar.footer.action');
  assert.equal(footers.length, 1);
  assert.equal(
    entries.some(({ options }) => options.name === 'sidebar.settings'),
    false,
  );
  const injected = footers[0].options.inject();
  const main = entries.find(
    ({ options }) => options.name === 'main' && options.key === 'zhuma-my-work',
  );
  const element = main.component({});
  const findShell = (node) =>
    !node?.props
      ? undefined
      : (node.props.shell ??
        (Array.isArray(node?.props?.children)
          ? node.props.children.map(findShell).find(Boolean)
          : findShell(node?.props?.children)));
  assert.equal(findShell(element), injected.shell);
  assert.equal(footers[0].component({ ...injected, wide: false }).props.shell, injected.shell);
  assert.equal(footers[0].component({ ...injected, wide: false }).props.wide, false);
  assert.deepEqual(reads, ['/zhuma-id/session']);
  injected.openWork();
  const epoch = injected.shell.getSnapshot().pageEpoch;
  injected.openWork();
  assert.equal(injected.shell.getSnapshot().pageEpoch, epoch);
  assert.equal(injected.shell.getSnapshot().pageActive, true);
  assert.equal(rpcCalls, 0);
  assert.equal(reads.length, 1);
  disposers.reverse().forEach((dispose) => dispose());
  assert.equal(injected.shell.getSnapshot().session.status, 'restoring');
  assert.equal(listeners.size, 0);
  assert.ok(entries.every(({ disposed }) => disposed));
});
