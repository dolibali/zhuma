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
      models = {
        kind: 'ready',
        items: catalogs.flatMap((catalog) =>
          catalog.map((model) => ({
            id: JSON.stringify([model.provider, model.id]),
            label: `${model.name.slice(0, 160)} · ${model.provider.slice(0, 100)}`,
            // Explicit application output budget, never a guessed provider default.
            value: {
              provider: id.parse(model.provider),
              model: id.parse(model.id),
              maxTokens: 4096,
            },
          })),
        ),
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
