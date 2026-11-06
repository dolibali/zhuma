/**
 * Apply the UI branding patch on the pinned tree and list the product-visible replacements.
 * Checks patch text and the patched welcome-notice spec only.
 * Does not open a window, switch themes, or run that upstream spec.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const upstream = join(root, 'upstream/deepseek-harness');
const patch = join(root, 'patches/deepseek-harness/zhuma-ui-branding.patch');
const desktop = join(root, 'patches/deepseek-harness/zhuma-desktop.patch');

/** Product-visible copy this leaf replaces. Paths are relative to the pinned tree. */
const branded = [
  [
    'apps/desktop/renderer/assets/welcome-brand.svg',
    '<text x="236" y="31" text-anchor="middle">Zhuma</text>',
  ],
  [
    'apps/desktop/src/locale.ts',
    "welcomeKeyDescription: 'Configure official DeepSeek models to start using Zhuma'",
  ],
  [
    'apps/desktop/src/locale.ts',
    "welcomeKeyDescription: '配置 DeepSeek 官方模型，即可开始使用 Zhuma'",
  ],
  ['apps/web/public/manifest.webmanifest', '"name": "Zhuma"'],
  ['apps/web/public/manifest.webmanifest', '"short_name": "Zhuma"'],
  ['packages/client/locale/src/locales/en.ts', "'brand.localBuild': 'Zhuma'"],
  ['packages/client/locale/src/locales/zh.ts', "'brand.localBuild': 'Zhuma'"],
  ['packages/client/ui-conversation/src/client/locales.ts', "'hero.headline': '从一项工作开始'"],
  ['packages/client/ui-conversation/src/client/locales.ts', "'hero.headline': 'Start with a task'"],
  ['packages/client/ui-conversation/src/client/skeleton/EmptyHero.tsx', "preview !== ''"],
  ['packages/client/ui-settings-models/src/client/locales.ts', "welcomeTitle: 'Zhuma'"],
  [
    'packages/client/ui-settings-models/src/client/locales.ts',
    'Welcome to Zhuma. Add a model provider when you need one; you can change it later in Settings.',
  ],
  [
    'packages/client/ui-settings-models/src/client/locales.ts',
    '欢迎使用 Zhuma。需要时再添加模型，之后也可在设置里修改。',
  ],
  [
    'packages/client/ui-settings-account/src/client/locales/onboarding.ts',
    "onboardingBrand: 'Zhuma'",
  ],
  ['packages/client/ui-settings-account/src/client/locales.ts', "backToHarness: 'Back to Zhuma'"],
  ['packages/client/ui-settings-account/src/client/locales.ts', "backToHarness: '返回 Zhuma'"],
  [
    'packages/client/ui-settings-account/src/client/locales.ts',
    "settingsSignedOutTitle: 'You are not signed in to DeepSeek'",
  ],
  [
    'packages/client/ui-settings-account/src/client/locales.ts',
    "settingsSignedOutTitle: '当前未登录 DeepSeek 账号'",
  ],
  ['packages/client/ui-sidebar-documentpreview/src/client/office/locales.ts', '运行 Zhuma 的主机'],
  [
    'packages/client/ui-sidebar-documentpreview/src/client/office/locales.ts',
    'computer running Zhuma',
  ],
  ['packages/client/ui-shortcuts/src/client/locales.ts', '请升级 Zhuma 后重试'],
  ['packages/client/ui-shortcuts/src/client/locales.ts', 'Upgrade Zhuma and try again.'],
  ['packages/client/ui-plugin-manager/src/client/locales.ts', '请重启 Zhuma 使更改生效'],
  ['packages/client/ui-plugin-manager/src/client/locales.ts', 'Restart Zhuma to apply the change.'],
  ['packages/client/ui-plugin-market/src/client/locales.ts', '随当前运行时提供'],
  ['packages/client/ui-plugin-market/src/client/locales.ts', 'Provided by this runtime'],
  [
    'packages/client/ui-agent-preset/src/client/locales.ts',
    'Extend the workbench through conversation.',
  ],
  ['packages/client/ui-agent-preset/src/client/locales.ts', '用对话扩展工作台'],
  [
    'packages/client/ui-entry-customization/src/client/locales.ts',
    'Create a plugin with a left sidebar entry.',
  ],
  ['packages/client/ui-entry-customization/src/client/locales.ts', '创建一个带左侧栏入口的插件。'],
  ['packages/client/web/src/boot-page.ts', "div(css.wordmark, 'Zhuma')"],
];

const files = [
  'apps/desktop/renderer/assets/welcome-brand.svg',
  'apps/desktop/src/locale.ts',
  'apps/web/public/manifest.webmanifest',
  'packages/client/locale/src/locales/en.ts',
  'packages/client/locale/src/locales/zh.ts',
  'packages/client/ui-agent-preset/src/client/locales.ts',
  'packages/client/ui-conversation/src/client/locales.ts',
  'packages/client/ui-conversation/src/client/skeleton/EmptyHero.tsx',
  'packages/client/ui-entry-customization/src/client/locales.ts',
  'packages/client/ui-plugin-manager/src/client/locales.ts',
  'packages/client/ui-plugin-market/src/client/locales.ts',
  'packages/client/ui-settings-account/src/client/locales.ts',
  'packages/client/ui-settings-account/src/client/locales/onboarding.ts',
  'packages/client/ui-settings-models/src/client/locales.ts',
  'packages/client/ui-shortcuts/src/client/locales.ts',
  'packages/client/ui-sidebar-documentpreview/src/client/office/locales.ts',
  'packages/client/web/src/boot-page.ts',
  'packages/client/ui-settings-models/tests/welcome-notice.client.spec.tsx',
];

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function read(stage, path) {
  return readFile(join(stage, path), 'utf8');
}

/** Copy only the files a patch needs so the check does not check out the whole upstream tree. */
async function stageFiles(stage, paths) {
  for (const path of paths) {
    const target = join(stage, path);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(upstream, path), target);
  }
}

test('UI branding patch applies alone and after the desktop patch', async (t) => {
  const lock = JSON.parse(await readFile(join(root, 'runtime.lock.json'), 'utf8'));
  const pin = lock.upstreams.deepseekHarness.commit;
  assert.equal(git(['rev-parse', 'HEAD'], upstream).trim(), pin);
  const patchText = await readFile(patch, 'utf8');
  const touched = [...patchText.matchAll(/^diff --git a\/(.+?) b\//gm)].map((match) => match[1]);
  assert.deepEqual(touched, files);
  const syntheticFixtures = ['sample-north-17', 'sample-south-42'];
  for (const fixture of syntheticFixtures)
    assert.equal(patchText.toLowerCase().includes(fixture), false);
  const added = patchText
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .join('\n');
  assert.equal(added.includes('DeepSeek Harness'), false);
  assert.equal(added.includes('@deepseek-ai/'), false);
  assert.equal(added.includes('dsh://'), false);

  const stage = await mkdtemp(join(tmpdir(), 'zhuma-ui-branding-'));
  t.after(() => rm(stage, { recursive: true, force: true }));
  await stageFiles(stage, files);
  git(['apply', '--check', patch], stage);
  git(
    [
      'apply',
      '--whitespace=nowarn',
      '--include=apps/desktop/src/locale.ts',
      '--include=apps/web/public/manifest.webmanifest',
      desktop,
    ],
    stage,
  );
  git(['apply', '--check', patch], stage);
  git(['apply', patch], stage);
  for (const [path, text] of branded)
    assert.equal((await read(stage, path)).includes(text), true, text);
  const manifest = await read(stage, 'apps/web/public/manifest.webmanifest');
  assert.equal(manifest.includes('"name": "Zhuma"'), true);
  assert.equal(manifest.includes('zhuma-icon.png'), true);
  const account = await read(stage, 'packages/client/ui-settings-account/src/client/locales.ts');
  assert.equal(account.includes("signedIn: 'Signed in to DeepSeek'"), true);
  assert.equal(account.includes('DeepSeek Harness'), false);
  const models = await read(stage, 'packages/client/ui-settings-models/src/client/locales.ts');
  assert.equal(models.includes("deepSeekAccount: 'DeepSeek Account'"), true);
  assert.equal(models.includes('$DSH_HOME'), true);
  assert.equal(models.includes('DeepSeek Harness'), false);
  const enWelcome =
    'Welcome to Zhuma. Add a model provider when you need one; you can change it later in Settings.';
  const zhWelcome = '欢迎使用 Zhuma。需要时再添加模型，之后也可在设置里修改。';
  assert.equal(models.includes(`welcomeBody: '${enWelcome}'`), true);
  assert.equal(models.includes(`welcomeBody: '${zhWelcome}'`), true);
  assert.equal(models.includes('keeps projects and files on this computer'), false);
  assert.equal(models.includes('项目和文件留在这台电脑'), false);
  const svg = await read(stage, 'apps/desktop/renderer/assets/welcome-brand.svg');
  assert.match(svg, /<svg width="472" height="40" viewBox="0 0 472 40"/);
  const wordmark = svg.match(/<text\b[^>]*>Zhuma<\/text>/);
  assert.ok(wordmark);
  assert.match(wordmark[0], /\bx="236"/);
  assert.match(wordmark[0], /\by="31"/);
  assert.match(wordmark[0], /\btext-anchor="middle"/);
  assert.equal(svg.includes('<text x="0"'), false);
  assert.equal((svg.match(/<text\b/g) ?? []).length, 1);
  const noticeSpec = await read(
    stage,
    'packages/client/ui-settings-models/tests/welcome-notice.client.spec.tsx',
  );
  assert.equal(noticeSpec.includes("title: 'Zhuma'"), true);
  assert.equal(noticeSpec.includes(`body: '${enWelcome}'`), true);
  assert.equal(noticeSpec.includes(`body: '${zhWelcome}'`), true);
  assert.equal(noticeSpec.includes("title: 'Preview Notice'"), false);
  assert.equal(noticeSpec.includes("querySelectorAll('p')).toHaveLength(1)"), true);
  assert.equal(noticeSpec.includes("querySelectorAll('p')).toHaveLength(2)"), false);
  assert.equal(noticeSpec.includes("welcomeBody.includes('\\n\\n')"), true);
  const plugins = await read(stage, 'packages/client/ui-plugin-manager/src/client/locales.ts');
  assert.equal(plugins.includes('dsh plugin'), true);
  const boot = await read(stage, 'packages/client/web/src/boot-page.ts');
  assert.equal(boot.includes("'HARNESS'"), false);
  assert.equal(git(['status', '--porcelain'], upstream).trim(), '');
});
