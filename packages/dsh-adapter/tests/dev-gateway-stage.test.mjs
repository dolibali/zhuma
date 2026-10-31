/** Contract: dev may append the 自定义提供商 overlay; formal package never does. No live gateway. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  allowDevModelGateway,
  composeStagedCordisPatch,
  desktopStageLaunch,
  DEV_MODEL_GATEWAY_IMAGE_IDS_ENV,
  isNonProductionEnv,
  renderDevModelGatewayCordisPatch,
  resolveDevModelGateway,
} from '../../../scripts/lib/dev-model-gateway.mjs';
import {
  DEV_MODEL_GATEWAY_IMAGE_IDS_ENV as imageIdsEnvFromSource,
  renderDevModelGatewayCordisPatch as renderFromSource,
  resolveDevModelGateway as resolveFromSource,
} from '../src/dev-model-gateway.ts';

const sourcePatch = 'upstream-base\n';
const marker = '\n# Zhuma workbench generated composition\n';
const overlay = '- id: ui-schedule\n  disabled: true\n';
const endpoint = 'https://example.invalid/v1';
const secret = 'fixture-secret';
const modelId = 'fixture-model';

function fictionalEnv(extra = {}) {
  return {
    ZHUMA_MODEL_BASE_URL: `${endpoint}/`,
    ZHUMA_MODEL_API_KEY: secret,
    ZHUMA_MODEL_ID: modelId,
    ZHUMA_WORKBENCH_DEV_GATEWAY: '1',
    ...extra,
  };
}

function stageArgv(installStageArgs) {
  return ['node', 'install-stage.mjs', ...installStageArgs];
}

function inputModalities(yaml, id) {
  const header = `          - id: ${JSON.stringify(id)}\n            input:\n`;
  const start = yaml.indexOf(header);
  assert.notEqual(start, -1, id);
  const modalities = [];
  for (const line of yaml.slice(start + header.length).split('\n')) {
    const match = /^              - ([a-z]+)$/.exec(line);
    if (!match) break;
    modalities.push(match[1]);
  }
  assert.ok(modalities.length > 0, id);
  return modalities;
}

function assertSameRenderers(env) {
  const fromScript = resolveDevModelGateway(env);
  const fromSource = resolveFromSource(env);
  assert.ok(fromScript);
  assert.deepEqual(fromSource, fromScript);
  assert.equal(renderFromSource(fromSource), renderDevModelGatewayCordisPatch(fromScript));
  return fromScript;
}

async function writeOverlay(directory, name, env, argv) {
  const file = join(directory, name);
  await writeFile(file, composeStagedCordisPatch({ sourcePatch, marker, overlay, env, argv }));
  return readFile(file, 'utf8');
}

test('契约：同一虚构环境，dev 可注入自定义提供商，正式 package 不含端点且不落凭据', async () => {
  const env = fictionalEnv();
  assert.equal(Object.hasOwn(env, 'NODE_ENV'), false);
  assert.equal(isNonProductionEnv(env), true);

  const dev = desktopStageLaunch('dev', env);
  const packaged = desktopStageLaunch('package', env);
  assert.deepEqual(dev.installStageArgs, ['--dev-gateway']);
  assert.equal(dev.env.ZHUMA_WORKBENCH_DEV_GATEWAY, '1');
  assert.deepEqual(packaged.installStageArgs, ['--no-dev-gateway']);
  assert.equal(packaged.env.ZHUMA_WORKBENCH_DEV_GATEWAY, '0');
  assert.equal(packaged.env.ZHUMA_MODEL_API_KEY, secret);

  const directory = await mkdtemp(join(tmpdir(), 'zhuma-gateway-stage-'));
  try {
    const devText = await writeOverlay(
      directory,
      'dev-cordis.patch.yml',
      dev.env,
      stageArgv(dev.installStageArgs),
    );
    const packageText = await writeOverlay(
      directory,
      'package-cordis.patch.yml',
      packaged.env,
      stageArgv(packaged.installStageArgs),
    );

    assert.match(devText, /llm-pi-ai/);
    assert.match(devText, /openai-completions/);
    assert.match(devText, new RegExp(endpoint.replaceAll('.', '\\.')));
    assert.match(devText, /apiKeyEnv: ZHUMA_MODEL_API_KEY/);
    assert.match(devText, new RegExp(modelId));
    assert.deepEqual(inputModalities(devText, modelId), ['text']);
    assert.equal(devText.includes('              - image'), false);
    assert.equal(devText.includes(secret), false);

    assert.match(packageText, /ui-schedule/);
    assert.equal(packageText.includes('llm-pi-ai'), false);
    assert.equal(packageText.includes('openai-completions'), false);
    assert.equal(packageText.includes('example.invalid'), false);
    assert.equal(packageText.includes('baseURL'), false);
    assert.equal(packageText.includes(modelId), false);
    assert.equal(packageText.includes(secret), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('契约：默认文本模型不声明 image；显式列入图像 id 才声明 image', () => {
  assert.equal(DEV_MODEL_GATEWAY_IMAGE_IDS_ENV, 'ZHUMA_MODEL_IMAGE_IDS');
  assert.equal(imageIdsEnvFromSource, DEV_MODEL_GATEWAY_IMAGE_IDS_ENV);

  const text = assertSameRenderers(fictionalEnv());
  assert.deepEqual(text.imageModelIds, []);
  const textYaml = renderDevModelGatewayCordisPatch(text);
  assert.deepEqual(inputModalities(textYaml, modelId), ['text']);
  assert.equal(textYaml.includes('              - image'), false);
  const { imageModelIds: omittedGrant, ...withoutGrant } = text;
  assert.equal(omittedGrant.length, 0);
  assert.deepEqual(inputModalities(renderDevModelGatewayCordisPatch(withoutGrant), modelId), [
    'text',
  ]);
  assert.deepEqual(inputModalities(renderFromSource(withoutGrant), modelId), ['text']);

  const imageEnv = fictionalEnv({
    [DEV_MODEL_GATEWAY_IMAGE_IDS_ENV]: `  ${modelId}  `,
  });
  const image = assertSameRenderers(imageEnv);
  assert.deepEqual(image.imageModelIds, [modelId]);
  assert.deepEqual(inputModalities(renderDevModelGatewayCordisPatch(image), modelId), [
    'text',
    'image',
  ]);

  const dev = desktopStageLaunch('dev', imageEnv);
  const devText = composeStagedCordisPatch({
    sourcePatch,
    marker,
    overlay,
    env: dev.env,
    argv: stageArgv(dev.installStageArgs),
  });
  assert.deepEqual(inputModalities(devText, modelId), ['text', 'image']);
  assert.equal(devText.includes(secret), false);

  const packaged = desktopStageLaunch('package', imageEnv);
  const packageText = composeStagedCordisPatch({
    sourcePatch,
    marker,
    overlay,
    env: packaged.env,
    argv: stageArgv(packaged.installStageArgs),
  });
  assert.equal(packageText.includes('llm-pi-ai'), false);
  assert.equal(packageText.includes('              - image'), false);
  assert.equal(packageText.includes(secret), false);

  const notAGrant = assertSameRenderers(
    fictionalEnv({ [DEV_MODEL_GATEWAY_IMAGE_IDS_ENV]: 'true' }),
  );
  assert.deepEqual(notAGrant.imageModelIds, []);
  assert.deepEqual(inputModalities(renderDevModelGatewayCordisPatch(notAGrant), modelId), ['text']);

  const stray = assertSameRenderers(
    fictionalEnv({ [DEV_MODEL_GATEWAY_IMAGE_IDS_ENV]: `${modelId}-vision` }),
  );
  assert.deepEqual(stray.imageModelIds, []);
  const strayYaml = renderDevModelGatewayCordisPatch(stray);
  assert.deepEqual(inputModalities(strayYaml, modelId), ['text']);
  assert.equal(strayYaml.includes(`${modelId}-vision`), false);

  const textId = 'fixture-text';
  const visionId = 'fixture-vision';
  const mixed = assertSameRenderers(
    fictionalEnv({
      ZHUMA_MODEL_ID: textId,
      ZHUMA_MODEL_IDS: `${textId}, ${visionId}`,
      [DEV_MODEL_GATEWAY_IMAGE_IDS_ENV]: visionId,
    }),
  );
  assert.deepEqual(mixed.modelIds, [textId, visionId]);
  assert.deepEqual(mixed.imageModelIds, [visionId]);
  const mixedYaml = renderDevModelGatewayCordisPatch(mixed);
  assert.deepEqual(inputModalities(mixedYaml, textId), ['text']);
  assert.deepEqual(inputModalities(mixedYaml, visionId), ['text', 'image']);
  assert.equal(renderFromSource(mixed), mixedYaml);
});

test('契约：未设 NODE_ENV 或仅有 ZHUMA_MODEL_* 不授权注入；dev 可关闭', async () => {
  const env = fictionalEnv();
  const bare = composeStagedCordisPatch({
    sourcePatch,
    marker,
    overlay,
    env,
    argv: stageArgv([]),
  });
  assert.equal(bare.includes('llm-pi-ai'), false);
  assert.equal(bare.includes('example.invalid'), false);
  assert.equal(bare.includes(secret), false);

  const refused = desktopStageLaunch('package', fictionalEnv({ NODE_ENV: 'production' }));
  const productionText = composeStagedCordisPatch({
    sourcePatch,
    marker,
    overlay,
    env: refused.env,
    argv: stageArgv(refused.installStageArgs),
  });
  assert.equal(productionText.includes('example.invalid'), false);
  assert.equal(productionText.includes(secret), false);

  const optedOut = desktopStageLaunch('dev', fictionalEnv({ ZHUMA_WORKBENCH_DEV_GATEWAY: '0' }));
  assert.deepEqual(optedOut.installStageArgs, ['--no-dev-gateway']);
  const optedOutText = composeStagedCordisPatch({
    sourcePatch,
    marker,
    overlay,
    env: optedOut.env,
    argv: stageArgv(optedOut.installStageArgs),
  });
  assert.equal(optedOutText.includes('llm-pi-ai'), false);
  assert.equal(optedOutText.includes(secret), false);

  const incomplete = desktopStageLaunch('dev', {
    ZHUMA_MODEL_BASE_URL: endpoint,
    ZHUMA_WORKBENCH_DEV_GATEWAY: '1',
  });
  const incompleteText = composeStagedCordisPatch({
    sourcePatch,
    marker,
    overlay,
    env: incomplete.env,
    argv: stageArgv(incomplete.installStageArgs),
  });
  assert.equal(incompleteText.includes('llm-pi-ai'), false);
  assert.equal(incompleteText.includes('example.invalid'), false);

  assert.equal(
    allowDevModelGateway(['node', 'install-stage.mjs', '--dev-gateway', '--no-dev-gateway']),
    false,
  );
  const conflictText = composeStagedCordisPatch({
    sourcePatch,
    marker,
    overlay,
    env,
    argv: ['node', 'install-stage.mjs', '--dev-gateway', '--no-dev-gateway'],
  });
  assert.equal(conflictText.includes('example.invalid'), false);
  assert.equal(conflictText.includes(secret), false);

  const packaged = desktopStageLaunch('package', env);
  const sneaky = composeStagedCordisPatch({
    sourcePatch,
    marker,
    overlay,
    env: packaged.env,
    argv: ['node', 'install-stage.mjs', '--dev-gateway'],
  });
  assert.equal(packaged.env.ZHUMA_WORKBENCH_DEV_GATEWAY, '0');
  assert.equal(sneaky.includes('llm-pi-ai'), false);
  assert.equal(sneaky.includes('example.invalid'), false);
  assert.equal(sneaky.includes(secret), false);
});

test('契约：install-stage 与正式 package 入口不按模型环境变量授权', async () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const stage = await readFile(join(root, 'scripts/workbench/install-stage.mjs'), 'utf8');
  const run = await readFile(join(root, 'scripts/desktop/run.mjs'), 'utf8');
  assert.match(stage, /composeStagedCordisPatch/);
  assert.equal(stage.includes('ZHUMA_MODEL_BASE_URL'), false);
  assert.equal(stage.includes('isNonProductionEnv'), false);
  assert.match(run, /desktopStageLaunch\(task, baseEnv\)/);
  assert.equal(run.includes('ZHUMA_MODEL_BASE_URL'), false);
  assert.equal(run.includes('isNonProductionEnv'), false);
});
