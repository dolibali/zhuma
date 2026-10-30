/**
 * Non-production AI gateway defaults for local desktop/host runs.
 * Explicit ZHUMA_MODEL_* environment variables always win.
 * Production (NODE_ENV === 'production') never applies these defaults.
 */

export const DEV_MODEL_GATEWAY_BASE_URL = 'http://10.155.208.190:31114/aigateway';
export const DEV_MODEL_GATEWAY_API_KEY = 'sk-Y7byE5r7sNBhLOwV3wuzIg';
/** Exact OpenAI-compatible model ids (slash form) exposed in the host picker. */
export const DEV_MODEL_GATEWAY_MODEL_IDS = [
  'moma/deepseek-v4.1-flash',
  'moma/glm-5.3-flash',
  'moma/glm-5.2',
  'moma/kimi-k3',
] as const;
export const DEV_MODEL_GATEWAY_PROVIDER_ID = 'zhuma';
export const DEV_MODEL_GATEWAY_API_KEY_ENV = 'ZHUMA_MODEL_API_KEY';

export function isNonProductionEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.NODE_ENV ?? '').trim() !== 'production';
}

export type ResolvedDevModelGateway = {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly modelIds: readonly string[];
  readonly fromDefaults: boolean;
};

/** Resolve gateway settings: env overrides, then non-production defaults. */
export function resolveDevModelGateway(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedDevModelGateway | null {
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
    fromDefaults: !baseUrl || !apiKey || !modelId,
  };
}

/** YAML fragment for llm-pi-ai; secrets stay in apiKeyEnv, never inlined. */
export function renderDevModelGatewayCordisPatch(gateway: ResolvedDevModelGateway): string {
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
