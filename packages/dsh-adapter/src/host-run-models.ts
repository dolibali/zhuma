import { symbols, type Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-llm';
import { z } from 'zod';
import { ExecutionRunError } from './execution-run-state.js';

export type HostRunModel = {
  provider: string;
  model: string;
  maxTokens: number;
  reasoningEffort?: string | undefined;
};
export type HostRunModels =
  | { kind: 'ready'; items: { id: string; label: string; value: HostRunModel }[] }
  | { kind: 'unavailable'; message: string };
const id = z.string().trim().min(1).max(200);

/** Passive official metadata only. Callers authorize both before and after this await. */
export async function readHostRunModels(
  ctx: Context,
  signal: AbortSignal,
  timeoutMs = 2500,
): Promise<HostRunModels> {
  const llm = ctx.llm;
  const origin = llm && (Reflect.get(llm, symbols.original) ?? llm);
  function active(currentSignal: AbortSignal) {
    currentSignal.throwIfAborted();
    const current = ctx.get('llm');
    if (!llm || !current || (Reflect.get(current, symbols.original) ?? current) !== origin)
      throw new ExecutionRunError('run-authority-unavailable');
  }
  active(signal);
  const providers = llm.listProviders();
  let models: HostRunModels;
  if (providers.length > 16) {
    models = { kind: 'unavailable', message: '模型目录过大，请先缩小已配置的供应商范围。' };
  } else {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    let cancel: (() => void) | undefined;
    try {
      // SDK listModels has no AbortSignal parameter. Bound our wait and contain
      // late rejection; completion never publishes without another member gate.
      const cancelled = new Promise<never>((_, reject) => {
        cancel = () => reject(deadline.reason);
        deadline.addEventListener('abort', cancel, { once: true });
      });
      deadline.throwIfAborted();
      const catalogs = await Promise.race([
        Promise.all(providers.map((provider) => llm.listModels(provider.id))),
        cancelled,
      ]);
      active(signal);
      if (catalogs.flat().length > 256) throw Error('Model catalog exceeds projection limit');
      const items = await Promise.race([
        Promise.all(
          catalogs.flat().map(async (model) => {
            const provider = id.parse(model.provider),
              selected = id.parse(model.id);
            let maxTokens = 4096; // Unknown routes keep the existing conservative budget.
            if (typeof llm.resolveModelInfo === 'function') {
              const resolved = await llm.resolveModelInfo(provider, selected, deadline);
              if (resolved.provider !== provider || resolved.id !== selected)
                throw Error('Model route changed');
              const configured = resolved.defaultMaxTokens;
              if (
                typeof configured === 'number' &&
                Number.isSafeInteger(configured) &&
                configured > 0
              ) {
                maxTokens = Math.min(16_384, configured);
                const context = resolved.context?.contextWindow;
                if (typeof context === 'number' && Number.isSafeInteger(context) && context > 0)
                  maxTokens = Math.min(maxTokens, context);
              }
            }
            return {
              id: JSON.stringify([provider, selected]),
              label: `${model.name.slice(0, 160)} · ${provider.slice(0, 100)}`,
              value: { provider, model: selected, maxTokens },
            };
          }),
        ),
        cancelled,
      ]);
      active(signal);
      models = {
        kind: 'ready',
        items,
      };
    } catch {
      active(signal);
      models = { kind: 'unavailable', message: '模型目录暂不可用，请检查模型配置后刷新。' };
    } finally {
      if (cancel) deadline.removeEventListener('abort', cancel);
    }
  }
  return models;
}
