/**
 * OpenAI-compatible 自定义提供商配置（仅环境变量）。
 * 读取 ZHUMA_MODEL_BASE_URL / ZHUMA_MODEL_API_KEY / ZHUMA_MODEL_ID（及可选 ZHUMA_MODEL_IDS）。
 * 仓库内不存放地址、密钥或模型 id 字面量；缺项时返回 null，由调用方点名缺失变量。
 */

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
};

function listedModelIds(env: NodeJS.ProcessEnv): string[] {
  return (env.ZHUMA_MODEL_IDS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** Resolve gateway settings from environment only. No hardcoded URL/key/models. */
export function resolveDevModelGateway(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedDevModelGateway | null {
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
