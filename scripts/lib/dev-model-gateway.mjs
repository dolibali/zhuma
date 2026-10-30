/**
 * OpenAI-compatible 自定义提供商配置（仅环境变量）。
 * Keep in sync with packages/dsh-adapter/src/dev-model-gateway.ts.
 * URL / key / model ids come only from ZHUMA_MODEL_*; never invent literals.
 */

export const DEV_MODEL_GATEWAY_PROVIDER_ID = 'zhuma';
export const DEV_MODEL_GATEWAY_API_KEY_ENV = 'ZHUMA_MODEL_API_KEY';

/**
 * NODE_ENV is not "production".
 * Unset NODE_ENV returns true. That is not authorization to inject the dev 自定义提供商.
 */
export function isNonProductionEnv(env = process.env) {
  return (env.NODE_ENV ?? '').trim() !== 'production';
}

function listedModelIds(env) {
  return (env.ZHUMA_MODEL_IDS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Normalize ZHUMA_MODEL_ID ↔ ZHUMA_MODEL_IDS from whatever the caller already set.
 * Does not invent URL, API key, or model ids.
 */
export function applyDevModelGatewayEnv(env = process.env) {
  const next = { ...env };
  const listed = listedModelIds(next);
  if (!next.ZHUMA_MODEL_ID?.trim() && listed.length > 0) {
    next.ZHUMA_MODEL_ID = listed[0];
  }
  if (!next.ZHUMA_MODEL_IDS?.trim() && next.ZHUMA_MODEL_ID?.trim()) {
    next.ZHUMA_MODEL_IDS = next.ZHUMA_MODEL_ID.trim();
  }
  return next;
}

/** Resolve from environment only. Returns null when URL/key/model missing. */
export function resolveDevModelGateway(env = process.env) {
  const baseUrl = env.ZHUMA_MODEL_BASE_URL?.trim() || '';
  const apiKey = env.ZHUMA_MODEL_API_KEY?.trim() || '';
  const modelId = env.ZHUMA_MODEL_ID?.trim() || '';
  const listed = listedModelIds(env);
  if (!baseUrl || !apiKey) return null;
  const modelIds = listed.length > 0 ? listed : modelId ? [modelId] : [];
  const resolvedModel = modelId || modelIds[0] || '';
  if (!resolvedModel) return null;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    modelId: resolvedModel,
    modelIds: modelIds.length > 0 ? modelIds : [resolvedModel],
  };
}

/** YAML for llm-pi-ai; key stays in apiKeyEnv (process env / credentials). */
export function renderDevModelGatewayCordisPatch(gateway) {
  const models = gateway.modelIds
    .map(
      (id) =>
        `          - id: ${JSON.stringify(id)}\n            input:\n              - text\n              - image`,
    )
    .join('\n');
  return [
    `- id: llm-pi-ai`,
    `  config:`,
    `    providers:`,
    `      ${DEV_MODEL_GATEWAY_PROVIDER_ID}:`,
    `        displayName: Zhuma Gateway`,
    `        api: openai-completions`,
    `        apiKeyEnv: ${DEV_MODEL_GATEWAY_API_KEY_ENV}`,
    `        baseURL: ${JSON.stringify(gateway.baseUrl)}`,
    `        models:`,
    models,
    '',
  ].join('\n');
}

/**
 * Explicit eligibility for the disposable 自定义提供商 overlay.
 * Only the dev entry's `--dev-gateway` counts. `--no-dev-gateway` refuses.
 * ZHUMA_MODEL_* and an unset NODE_ENV are not authorization.
 */
export function allowDevModelGateway(argv = []) {
  if (argv.includes('--no-dev-gateway')) return false;
  return argv.includes('--dev-gateway');
}

/**
 * YAML appended to the disposable cordis overlay.
 * Requires the dev-entry grant and ZHUMA_WORKBENCH_DEV_GATEWAY=1.
 * ZHUMA_MODEL_* alone and an unset NODE_ENV do not qualify. The API key is never written.
 */
export function devModelGatewayOverlay(env = process.env, allowed = false) {
  if (allowed !== true) return '';
  if (env.ZHUMA_WORKBENCH_DEV_GATEWAY !== '1') return '';
  const gateway = resolveDevModelGateway(env);
  if (!gateway) return '';
  const yaml = renderDevModelGatewayCordisPatch(gateway);
  if (yaml.includes(gateway.apiKey)) {
    throw new Error('Refusing to persist 自定义提供商 credentials in the workbench overlay.');
  }
  return '\n' + yaml;
}

/** Cordis patch written by install-stage. Gateway YAML needs --dev-gateway and DEV_GATEWAY=1. */
export function composeStagedCordisPatch({ sourcePatch, marker, overlay, env, argv }) {
  return sourcePatch + marker + overlay + devModelGatewayOverlay(env, allowDevModelGateway(argv));
}

/**
 * Env and install-stage args for desktop dev vs formal package.
 * Package always refuses injection, including when the caller inherited
 * ZHUMA_WORKBENCH_DEV_GATEWAY=1 and ZHUMA_MODEL_*. Unset NODE_ENV is not a grant.
 */
export function desktopStageLaunch(task, env = process.env) {
  if (task === 'dev') {
    const flag = env.ZHUMA_WORKBENCH_DEV_GATEWAY ?? '1';
    return {
      env: {
        ...applyDevModelGatewayEnv(env),
        ZHUMA_WORKBENCH_DEV_GATEWAY: flag,
      },
      installStageArgs: flag === '1' ? ['--dev-gateway'] : ['--no-dev-gateway'],
    };
  }
  if (task === 'package') {
    return {
      env: { ...env, ZHUMA_WORKBENCH_DEV_GATEWAY: '0' },
      installStageArgs: ['--no-dev-gateway'],
    };
  }
  throw new Error(`Unknown desktop task: ${task}`);
}
