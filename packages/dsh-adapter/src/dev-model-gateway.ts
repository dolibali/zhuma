/**
 * OpenAI-compatible 自定义提供商配置（仅环境变量）。
 * 读取 ZHUMA_MODEL_BASE_URL / ZHUMA_MODEL_API_KEY / ZHUMA_MODEL_ID（及可选 ZHUMA_MODEL_IDS）。
 * 仓库内不存放地址、密钥或模型 id 字面量；缺项时返回 null，由调用方点名缺失变量。
 * 模型 id 不表示图像能力。图像 input 只授予 ZHUMA_MODEL_IMAGE_IDS
 * 中精确匹配的 id，没有通配。
 * Keep in sync with scripts/lib/dev-model-gateway.mjs.
 */

export const DEV_MODEL_GATEWAY_PROVIDER_ID = 'zhuma';
export const DEV_MODEL_GATEWAY_API_KEY_ENV = 'ZHUMA_MODEL_API_KEY';
export const DEV_MODEL_GATEWAY_IMAGE_IDS_ENV = 'ZHUMA_MODEL_IMAGE_IDS';

/**
 * NODE_ENV is not "production".
 * Unset NODE_ENV returns true. That is not authorization to inject the dev 自定义提供商.
 */
export function isNonProductionEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.NODE_ENV ?? '').trim() !== 'production';
}

export type ResolvedDevModelGateway = {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly modelIds: readonly string[];
  /** Exact ids granted image input. Empty means every catalog model is text only. */
  readonly imageModelIds: readonly string[];
};

function listedCsv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function listedModelIds(env: NodeJS.ProcessEnv): string[] {
  return listedCsv(env.ZHUMA_MODEL_IDS);
}

/** Explicit image grant. Exact id match only; a model id is not itself a grant. */
function listedImageModelIds(env: NodeJS.ProcessEnv): string[] {
  return listedCsv(env[DEV_MODEL_GATEWAY_IMAGE_IDS_ENV]);
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
  const catalog = modelIds.length > 0 ? modelIds : [resolvedModel];
  const granted = new Set(listedImageModelIds(env));
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    modelId: resolvedModel,
    modelIds: catalog,
    imageModelIds: catalog.filter((id) => granted.has(id)),
  };
}

function renderedModel(id: string, image: boolean): string {
  const modalities = image ? ['text', 'image'] : ['text'];
  const input = modalities.map((kind) => `              - ${kind}`).join('\n');
  return `          - id: ${JSON.stringify(id)}\n            input:\n${input}`;
}

/** YAML fragment for llm-pi-ai; secrets stay in apiKeyEnv, never inlined. Default input is text. */
export function renderDevModelGatewayCordisPatch(gateway: ResolvedDevModelGateway): string {
  const imageIds = new Set(gateway.imageModelIds ?? []);
  const models = gateway.modelIds.map((id) => renderedModel(id, imageIds.has(id))).join('\n');
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
