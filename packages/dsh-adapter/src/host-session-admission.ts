import type { Context } from '@deepseek-ai/cordis';

/** Actual C reverse lookup; null alone certifies an ordinary Session. Throws,
 * unknown namespaces, damaged records and closed owners must never fall back. */
export interface NativeSessionAdmissionSource {
  lookupNativeSession(nativeSessionId: string): object | null | Promise<object | null>;
}
type Admission = (
  method: string,
  args: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
) => Promise<boolean>;
interface SessionGateway {
  registerSessionAdmission(admit: Admission): () => void;
}
function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
/** Arguments have already passed the official endpoint's exact schema. These
 * are its actual request/address shapes, never a recursive scan of prompt data. */
export function nativeSessionCommandIds(
  args: Readonly<Record<string, unknown>>,
): readonly string[] {
  const request = record(args.request);
  const address = record(request?.address);
  const values = [
    request?.sessionId,
    address?.sessionId,
    address?.parentSessionId,
    address?.childSessionId,
  ];
  return [...new Set(values.filter((value): value is string => typeof value === 'string'))];
}

/** Registers before product async initialization. The patched Gateway keeps its
 * required bit after this exact registration unloads, so a gap stays closed. */
export function openHostSessionAdmission(
  ctx: Context,
  current: () => NativeSessionAdmissionSource | undefined,
) {
  let closed = false;
  const stops = new Set<() => void>();
  ctx.inject(['typertGateway'], (owner) => {
    const candidate: unknown = owner.get('typertGateway');
    if (
      !record(candidate) ||
      typeof Reflect.get(candidate as object, 'registerSessionAdmission') !== 'function'
    )
      throw new Error('Zhuma requires the matching Session admission runtime patch.');
    const gateway = candidate as SessionGateway;
    let active = true;
    const dispose = gateway.registerSessionAdmission(async (_method, args, signal) => {
      signal.throwIfAborted();
      const source = current();
      if (closed || !active || !source) return false;
      for (const id of nativeSessionCommandIds(args)) {
        const result = await source.lookupNativeSession(id);
        signal.throwIfAborted();
        if (result !== null) return false;
      }
      return !closed && active && current() === source;
    });
    const stop = () => {
      active = false;
      stops.delete(stop);
      dispose();
    };
    stops.add(stop);
    owner.effect(() => stop);
  });
  const close = () => {
    closed = true;
    for (const stop of stops) stop();
    stops.clear();
  };
  ctx.effect(() => close);
  return { close };
}
