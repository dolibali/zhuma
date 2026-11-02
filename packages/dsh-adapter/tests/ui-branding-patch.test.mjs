/** Apply the UI branding patch on the pinned tree and list the product-visible replacements. */
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
  ['apps/desktop/renderer/assets/welcome-brand.svg', '<text x="0" y="31">Zhuma</text>'],
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
    'Zhuma keeps projects and files on this computer.',
  ],
  [
    'packages/client/ui-settings-models/src/client/locales.ts',
    'Zhuma 把项目和文件留在这台电脑上。',
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
  const banned = [
    String.fromCharCode(0x6e5b, 0x5362),
    String.fromCharCode(0x7075, 0x757f),
    'zhan' + 'lu',
    'ling' + 'ji',
  ];
  for (const word of banned) assert.equal(patchText.toLowerCase().includes(word), false, word);
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
  const plugins = await read(stage, 'packages/client/ui-plugin-manager/src/client/locales.ts');
  assert.equal(plugins.includes('dsh plugin'), true);
  const boot = await read(stage, 'packages/client/web/src/boot-page.ts');
  assert.equal(boot.includes("'HARNESS'"), false);
  assert.equal(git(['status', '--porcelain'], upstream).trim(), '');
});
