import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots';

// Exercise the pinned SDK's public registry entry without upstream source imports.
function createSlotCore() {
  const core = new SlotCore();
  core.register(
    {
      name: 'root',
      children: {
        main: { kind: 'keyed', scope: 'root' },
        'sidebar.panellist': { kind: 'list', scope: 'root' },
        'sidebar.footer.action': { kind: 'list', scope: 'root' },
        'sidebar.settings': { kind: 'single', scope: 'root' },
      },
    },
    () => null,
  );
  return core;
}

test('pinned SDK list registration requires an id and rejects duplicate live ids', async () => {
  const core = createSlotCore();
  const options = { name: 'sidebar.footer.action', id: 'zhuma-account' };
  assert.throws(
    () => core.register({ name: options.name }, () => null),
    /list slot "sidebar.footer.action" requires options.id/,
  );
  const dispose = core.register(options, () => null);
  assert.throws(
    () => core.register(options, () => null),
    /already has an entry with id "zhuma-account"/,
  );
  dispose();
  const disposeAgain = core.register(options, () => null);
  assert.equal(core.entriesOfSlot(options.name).length, 1);
  disposeAgain();
  assert.equal(core.entriesOfSlot(options.name).length, 0);
});

// Compiled real plugin + pinned SDK registry core. No host rendering or sidebar imitation.
async function checkComposition({ boot, initialPanel = null, restored = false } = {}) {
  const core = createSlotCore();
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
    __ZHUMA_WORKBENCH_BOOT__: boot,
    navigator: { userAgent: 'Node contract' },
    document: { createElement: () => ({ textContent: '', remove() {} }), head: { append() {} } },
    fetch: async (url) => {
      reads.push(url);
      return restored
        ? Response.json({
            ok: true,
            accountId: 'contract-member',
            principal: { kind: 'zhuma-member', memberId: 'contract-member' },
            peerId: 'contract-peer',
            spaces: [{ id: 'personal-contract', kind: 'personal', name: 'Current member space' }],
          })
        : new Response('', { status: 401 });
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
  let panel = { activePanelId: initialPanel },
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
        const dispose = core.register(options, component);
        const entry = { options, component, disposed: false };
        entries.push(entry);
        return () => {
          dispose();
          entry.disposed = true;
        };
      },
    },
  };
  try {
    module.exports.apply(ctx);
  } catch (error) {
    assert.equal(entries.length, 0);
    assert.equal(reads.length, 0);
    throw error;
  }
  await new Promise((resolve) => setImmediate(resolve));
  const footers = entries.filter(({ options }) => options.name === 'sidebar.footer.action');
  const memberMode = boot?.deploymentMode === 'multi-member';
  const legacyIds = ['zhuma-workbench', 'zhuma-experts'];
  assert.equal(
    panel.activePanelId,
    memberMode && (initialPanel === null || legacyIds.includes(initialPanel))
      ? 'zhuma-my-work'
      : (initialPanel ?? 'zhuma-workbench'),
  );
  const legacyNav = entries.filter(
    ({ options }) => options.name === 'sidebar.panellist' && legacyIds.includes(options.id),
  );
  assert.equal(legacyNav.length, memberMode ? 0 : 2);
  assert.equal(footers.length, 1);
  assert.equal(footers[0].options.id, 'zhuma-account');
  assert.equal(core.entriesOfSlot('sidebar.footer.action').length, 1);
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
  assert.deepEqual(reads, Array(restored ? 2 : 1).fill('/zhuma-id/session'));
  if (memberMode && panel.activePanelId === 'zhuma-my-work') {
    const html = require('react-dom/server').renderToStaticMarkup(element);
    assert.ok(html.includes(restored ? '我的工作' : '登录工作台'));
    assert.equal(html.includes('HTTP 404'), false);
    assert.equal(html.includes('重新连接'), false);
  }
  injected.openWork();
  const epoch = injected.shell.getSnapshot().pageEpoch;
  injected.openWork();
  assert.equal(injected.shell.getSnapshot().pageEpoch, epoch);
  assert.equal(injected.shell.getSnapshot().pageActive, true);
  assert.equal(rpcCalls, 0);
  assert.equal(reads.length, restored ? 2 : 1);
  disposers.reverse().forEach((dispose) => dispose());
  assert.equal(injected.shell.getSnapshot().session.status, 'restoring');
  assert.equal(listeners.size, 0);
  assert.ok(entries.every(({ disposed }) => disposed));
  assert.equal(core.entriesOfSlot('sidebar.footer.action').length, 0);
}

test('member plugin composition contract: actual footer/main registrations share one owned session and preserve Settings', () =>
  checkComposition());
test('member plugin composition contract: explicit legacy boot preserves owner navigation and its landing', () =>
  checkComposition({ boot: { version: 1, deploymentMode: 'legacy-single-user' } }));
for (const restored of [false, true]) {
  test(`member plugin composition contract: member cold landing shows ${restored ? 'restored work' : 'login'} without owner RPC`, () =>
    checkComposition({ boot: { version: 1, deploymentMode: 'multi-member' }, restored }));
}
for (const initialPanel of ['zhuma-workbench', 'zhuma-experts', 'official-existing-panel']) {
  test(`member plugin composition contract: member boot handles prior panel ${initialPanel}`, () =>
    checkComposition({ boot: { version: 1, deploymentMode: 'multi-member' }, initialPanel }));
}
test('member plugin composition contract: invalid presentation boot fails before effects or RPC', async () => {
  for (const boot of [
    null,
    'multi-member',
    { version: 2, deploymentMode: 'multi-member' },
    { version: 1, deploymentMode: 'owner' },
    { version: 1, deploymentMode: 'multi-member', identityBootstrapKey: 'not-a-client-field' },
  ]) {
    await assert.rejects(checkComposition({ boot }), /Invalid workbench boot configuration/);
  }
});
