/** Execute the patched official registration with synthetic UI ports; no GUI or credentials proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const path = 'packages/client/ui-settings-models/src/client/index.ts';

function registrations(text, desktop) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'apply',
  );
  assert.ok(declaration);
  const compiled = ts.transpileModule(declaration.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const entries = [],
    effects = [];
  let welcomeReads = 0;
  const ports = {
    globalThis: desktop ? { dshDesktop: {} } : {},
    ONBOARDING_CONFIG_GLOBAL: '__DSH_MODELS_ONBOARDING__',
    Config: () => ({ credentialOnboarding: false }),
    en: {},
    zh: {},
    NS: 'settings.models',
    createSettingsSchemaOperations: () => ({}),
    createModelsOperations: () => ({}),
    refreshIfLoaded() {},
    ModelsSettingsStore: class {
      store = {};
    },
    ModelsSection: Symbol('original-models'),
    DeepSeekOnboardingDialog: Symbol('original-credentials'),
    WelcomeNotice: Symbol('preview'),
    WelcomeNoticeStore: class {
      store = {};
      dispose() {}
    },
    WELCOME_NOTICE_SETTINGS_NAMESPACE: 'preview-fixture',
  };
  const apply = new Function(...Object.keys(ports), `const exports={};${compiled};return apply;`)(
    ...Object.values(ports),
  );
  apply({
    effect(callback) {
      effects.push(callback());
    },
    locale: { register: () => () => {}, bind: () => () => 'Models' },
    settingsSchema: {},
    configForms: {
      describe: () => ({}),
      get() {
        welcomeReads++;
        return {};
      },
    },
    remote: { $on: () => () => {} },
    on: () => () => {},
    slots: {
      inject(_slot, callback) {
        callback();
      },
      register(options, component) {
        entries.push({ options, component });
        return () => {};
      },
    },
  });
  effects.toReversed().forEach((dispose) => dispose?.());
  return { entries, welcomeReads, ports };
}

test('desktop overlay removes only the preview registration while original Models and credential surfaces stay available', async (t) => {
  const original = await readFile(join(root, 'upstream/deepseek-harness', path), 'utf8');
  const stage = await mkdtemp(join(tmpdir(), 'zhuma-preview-notice-contract-'));
  t.after(() => rm(stage, { recursive: true, force: true }));
  await mkdir(dirname(join(stage, path)), { recursive: true });
  await writeFile(join(stage, path), original);
  execFileSync(
    'git',
    ['apply', `--include=${path}`, join(root, 'patches/deepseek-harness/zhuma-desktop.patch')],
    { cwd: stage },
  );
  const patched = await readFile(join(stage, path), 'utf8');
  assert.deepEqual(
    registrations(original, false).entries.map(({ options }) => options.id),
    ['models', 'welcome-notice', 'deepseek-official'],
  );
  for (const desktop of [false, true]) {
    const { entries, welcomeReads, ports } = registrations(patched, desktop);
    assert.deepEqual(
      entries.map(({ options }) => options.id),
      ['models', 'deepseek-official'],
    );
    assert.equal(entries[0].component, ports.ModelsSection);
    assert.equal(entries[1].component, ports.DeepSeekOnboardingDialog);
    assert.equal(entries[1].options.inject().automatic, false);
    assert.equal(welcomeReads, 0, 'No fake acknowledgement or welcome settings access');
  }
  assert.equal(await readFile(join(root, 'upstream/deepseek-harness', path), 'utf8'), original);
});
