import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import { z } from 'zod';
import { WorkbenchError } from '@zhuma/agent-core';
import type { PlanningModel } from './workbench-service.js';
import { readHostRunModels } from './host-run-models.js';

const routeName = z.string().trim().min(1).max(200);
const selectSchema = z.strictObject({ provider: routeName, model: routeName });

interface PlanningRoute {
  readonly provider: string;
  readonly model: string;
}
export interface PlanningModelOption {
  readonly id: string;
  readonly label: string;
  readonly provider: string;
  readonly model: string;
}
/** Fixed keys so a member projection can reject unexpected catalog fields. */
export interface PlanningModelCatalog {
  readonly kind: 'ready' | 'unavailable';
  readonly label: string;
  readonly selectedId: string | null;
  readonly message: string;
  readonly items: readonly PlanningModelOption[];
}

const unavailableMessage = '模型目录暂不可用，请检查模型配置后刷新。';

/** SDK-normalized stable facts only. Never surface provider messages, endpoints
 * or request identities; this classification does not retry or change routing. */
function planningFailure(failure: { readonly code: string; readonly status?: number }) {
  const mapped: Record<string, readonly [string, string]> = {
    MISSING_CREDENTIAL: [
      'model-credentials-missing',
      '规划服务未配置所选模型的凭据，请检查当前服务的模型设置。',
    ],
    INVALID_CREDENTIAL: [
      'model-credentials-invalid',
      '所选模型的凭据格式无效，请联系管理员检查模型设置。',
    ],
    AUTH: ['model-access-denied', '模型服务拒绝了请求，请联系管理员检查凭据与访问权限。'],
    QUOTA: ['model-quota', '模型服务额度不足，请联系管理员检查账户额度。'],
    ACCOUNT_QUOTA: ['model-quota', '模型服务额度不足，请联系管理员检查账户额度。'],
    RATE_LIMIT: ['model-rate-limit', '模型服务请求过于频繁，请稍后再发起规划。'],
    TIMEOUT: ['model-timeout', '模型请求超时，请检查服务连接后再发起规划。'],
    TRANSPORT: ['model-connection', '无法连接模型服务，请联系管理员检查网络与服务连接。'],
    SERVER: ['model-service', '模型服务暂不可用，请稍后再发起规划。'],
    NO_ADAPTER: ['model-unavailable', '所选模型适配器不可用，请联系管理员检查模型设置。'],
    CONTEXT_WINDOW_EXCEEDED: [
      'model-context-limit',
      '任务材料超出模型容量，请缩小任务范围或减少材料。',
    ],
    INVALID_REQUEST: [
      'model-request-rejected',
      '模型服务不接受本次请求，请检查任务材料与所选模型设置。',
    ],
  };
  let value = Object.hasOwn(mapped, failure.code) ? mapped[failure.code] : undefined;
  const status = failure.status;
  if (!value && typeof status === 'number' && Number.isInteger(status)) {
    if (status === 401 || status === 403) value = mapped.AUTH;
    else if (status === 402) value = mapped.QUOTA;
    else if (status === 429) value = mapped.RATE_LIMIT;
    else if (status === 408 || status === 504) value = mapped.TIMEOUT;
    else if (status >= 500 && status <= 599) value = mapped.SERVER;
  }
  return new WorkbenchError(
    ...(value ??
      (['model-incomplete', '模型请求未正常结束，请检查模型连接或缩小任务后重试。'] as const)),
  );
}

function routeLabel(route: Pick<PlanningRoute, 'provider' | 'model'> | undefined): string {
  return route ? `${route.provider} / ${route.model}` : '未配置模型';
}

function sameRoute(
  left: Pick<PlanningRoute, 'provider' | 'model'> | undefined,
  right: Pick<PlanningRoute, 'provider' | 'model'> | undefined,
): boolean {
  return !!left && !!right && left.provider === right.provider && left.model === right.model;
}

/**
 * Planning reads the Host's shared default model and the same provider catalog
 * used for configured routes. A panel choice is kept for later plan calls even
 * when the deployment has no configuration editor to persist the shared default.
 */
export function createPlanningModels(ctx: Context) {
  let override: PlanningRoute | undefined;
  let generation = 0;

  function readOfficial() {
    const defaults = ctx.get('agentDefaultModel');
    if (!defaults || typeof defaults.currentSelection !== 'function') return undefined;
    try {
      const route = defaults.currentSelection();
      if (
        !routeName.safeParse(route?.provider).success ||
        !routeName.safeParse(route?.model).success
      )
        return undefined;
      return route;
    } catch {
      return undefined;
    }
  }

  function effective(): PlanningRoute | undefined {
    const official = readOfficial();
    if (!override) return official;
    if (sameRoute(official, override)) return official;
    return override;
  }

  function catalogFrom(
    items: readonly PlanningModelOption[],
    message: string,
    kind: PlanningModelCatalog['kind'],
  ): PlanningModelCatalog {
    const route = effective();
    const selected = items.find((item) => sameRoute(item, route));
    return {
      kind,
      label: routeLabel(route),
      selectedId: selected?.id ?? null,
      message,
      items: kind === 'ready' ? items : [],
    };
  }

  async function listed(signal: AbortSignal): Promise<PlanningModelCatalog> {
    try {
      const models = await readHostRunModels(ctx, signal);
      signal.throwIfAborted();
      if (models.kind !== 'ready')
        return catalogFrom([], models.message || unavailableMessage, 'unavailable');
      const items = models.items.map((item) => ({
        id: item.id,
        label: `${item.value.provider} / ${item.value.model}`,
        provider: item.value.provider,
        model: item.value.model,
      }));
      return catalogFrom(items, '', 'ready');
    } catch (error) {
      if (signal.aborted) throw error;
      return catalogFrom([], unavailableMessage, 'unavailable');
    }
  }

  /** Reading and manual editing do not require a configured model service. */
  function planningModel(): PlanningModel | undefined {
    const llm = ctx.get('llm');
    const route = effective();
    if (!llm || !route) return undefined;
    return {
      name: routeLabel(route),
      generate: async (system, input, abort) => {
        const call = await llm.prepareCall({ ...route, maxTokens: 12000 }, abort);
        let text = '';
        let stopped = false;
        for await (const chunk of call.stream({
          ...call.config,
          system,
          messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
          signal: abort,
        })) {
          abort.throwIfAborted();
          if (chunk.type === 'text-delta') text += chunk.text;
          if (text.length > 150000)
            throw new WorkbenchError('output-limit', '模型输出过长，请缩小任务范围。');
          if (chunk.type === 'finish') {
            if (chunk.reason.kind === 'error') throw planningFailure(chunk.reason.failure);
            stopped = chunk.reason.kind === 'stop';
          }
        }
        if (!stopped)
          throw new WorkbenchError(
            'model-incomplete',
            '模型请求未正常结束，请检查模型连接或缩小任务后重试。',
          );
        return text;
      },
    };
  }

  return {
    planningModel,
    catalog(signal: AbortSignal) {
      return listed(signal);
    },
    async select(input: unknown, signal: AbortSignal): Promise<PlanningModelCatalog> {
      const ticket = ++generation;
      const requested = selectSchema.parse(input);
      const current = await listed(signal);
      if (current.kind !== 'ready')
        throw new WorkbenchError('model-unavailable', current.message || unavailableMessage);
      const match = current.items.find((item) => sameRoute(item, requested));
      if (!match)
        throw new WorkbenchError('model-unavailable', '所选规划模型当前不可用，请刷新后重试。');
      const official = readOfficial();
      const next =
        sameRoute(official, match) && official
          ? official
          : { provider: match.provider, model: match.model };
      const defaults = ctx.get('agentDefaultModel');
      if (defaults && typeof defaults.saveSelection === 'function') {
        try {
          await defaults.saveSelection(next);
        } catch {
          // A missing configuration editor, or a failed profile write, must not
          // block the planning route the panel just accepted from the catalog.
        }
      }
      signal.throwIfAborted();
      if (ticket === generation) {
        const saved = readOfficial();
        override = sameRoute(saved, next) ? undefined : next;
      }
      signal.throwIfAborted();
      return listed(signal);
    },
  };
}
