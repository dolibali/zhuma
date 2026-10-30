/**
 * Non-production AI gateway defaults for desktop:dev / install-stage.
 * Keep in sync with packages/dsh-adapter/src/dev-model-gateway.ts.
 * Explicit ZHUMA_MODEL_* env always wins; production never applies defaults.
 */

export const DEV_MODEL_GATEWAY_BASE_URL = 'http://10.155.208.190:31114/aigateway';
export const DEV_MODEL_GATEWAY_API_KEY = 'sk-Y7byE5r7sNBhLOwV3wuzIg';
export const DEV_MODEL_GATEWAY_MODEL_IDS = [
  'moma/deepseek-v4.1-flash',
  'moma/glm-5.3-flash',
  'moma/glm-5.2',
  'moma/kimi-k3',
];
export const DEV_MODEL_GATEWAY_PROVIDER_ID = 'zhuma';
export const DEV_MODEL_GATEWAY_API_KEY_ENV = 'ZHUMA_MODEL_API_KEY';

export function isNonProductionEnv(env = process.env) {
  return (env.NODE_ENV ?? '').trim() !== 'production';
}

/** Fill missing ZHUMA_MODEL_* from non-production defaults; never overwrite set values. */
export function applyDevModelGatewayEnv(env = process.env) {
  if (!isNonProductionEnv(env)) return env;
  const next = { ...env };
  if (!next.ZHUMA_MODEL_BASE_URL?.trim()) next.ZHUMA_MODEL_BASE_URL = DEV_MODEL_GATEWAY_BASE_URL;
  if (!next.ZHUMA_MODEL_API_KEY?.trim()) next.ZHUMA_MODEL_API_KEY = DEV_MODEL_GATEWAY_API_KEY;
  if (!next.ZHUMA_MODEL_ID?.trim()) next.ZHUMA_MODEL_ID = DEV_MODEL_GATEWAY_MODEL_IDS[0];
  if (!next.ZHUMA_MODEL_IDS?.trim()) next.ZHUMA_MODEL_IDS = DEV_MODEL_GATEWAY_MODEL_IDS.join(',');
  return next;
}

export function resolveDevModelGateway(env = process.env) {
  const baseUrl = env.ZHUMA_MODEL_BASE_URL?.trim() || '';
  const apiKey = env.ZHUMA_MODEL_API_KEY?.trim() || '';
  const modelId = env.ZHUMA_MODEL_ID?.trim() || '';
  const listed = env.ZHUMA_MODEL_IDS?.split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const allowDefaults = isNonProductionEnv(env);
  if (!allowDefaults && (!baseUrl || !apiKey)) return null;
  const resolvedBase = baseUrl || (allowDefaults ? DEV_MODEL_GATEWAY_BASE_URL : '');
  const resolvedKey = apiKey || (allowDefaults ? DEV_MODEL_GATEWAY_API_KEY : '');
  if (!resolvedBase || !resolvedKey) return null;
  const modelIds =
    listed && listed.length > 0
      ? listed
      : allowDefaults
        ? [...DEV_MODEL_GATEWAY_MODEL_IDS]
        : modelId
          ? [modelId]
          : [...DEV_MODEL_GATEWAY_MODEL_IDS];
  const resolvedModel =
    modelId || modelIds[0] || (allowDefaults ? DEV_MODEL_GATEWAY_MODEL_IDS[0] : '');
  if (!resolvedModel) return null;
  return {
    baseUrl: resolvedBase.replace(/\/+$/, ''),
    apiKey: resolvedKey,
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
