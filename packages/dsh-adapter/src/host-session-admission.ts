import type { Context } from '@deepseek-ai/cordis';
import { prepareHostAcpSessionProjection } from './host-acp-session-projection.js';

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
  registerSessionResultProjection(
    prepare: (
      method: string,
      args: Readonly<Record<string, unknown>>,
      signal: AbortSignal,
    ) => { assertCurrent(): void; project(value: unknown): Promise<unknown> },
  ): () => void;
}
// Named values of the fixed plugin's actual generated Remote parameters.
const acpSessionArgs: Readonly<Record<string, readonly string[]>> = {
  auditTimeline: ['sessionId'],
  activitySnapshot: ['sessionId'],
  activityDetail: ['sessionId'],
  activityPage: ['sessionId'],
  activityFollow: ['sessionId'],
  teamMembers: ['lead'],
  approvalChildren: ['parent'],
  teamMemberModels: ['lead', 'sessionId'],
  setTeamMemberModel: ['lead', 'sessionId'],
  setTeamMemberMode: ['lead', 'sessionId'],
  agentSessionSnapshot: ['sessionId'],
  agentSessionFollow: ['sessionId'],
  setAgentSessionOption: ['sessionId'],
  toolApprovalPolicy: ['sessionId'],
  setToolApprovalPolicy: ['sessionId'],
  toolApprovalPolicyFollow: ['sessionId'],
  recoverySnapshot: ['sessionId'],
  recoveryFollow: ['sessionId'],
  retryOriginal: ['sessionId'],
  rebindRecoveryBlank: ['sessionId'],
  backendOf: ['sessionId'],
};
const acpCatalogMethods = new Set(['health', 'projectedSubagentIds', 'ownedProviderRoutes']);
function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
/** Arguments have already passed the official endpoint's exact schema. These
 * are its actual request/address shapes, never a recursive scan of prompt data. */
export function nativeSessionCommandIds(
  args: Readonly<Record<string, unknown>>,
  method = '',
): readonly string[] {
  const request = record(args.request);
  const address = record(request?.address);
  const values = [
    ...(method.startsWith('dshAcp/')
      ? (acpSessionArgs[method.slice(7)] ?? []).map((name) => args[name])
      : []),
    request?.sessionId,
    address?.sessionId,
    address?.parentSessionId,
    address?.childSessionId,
    ...(method.startsWith('dshAcp/')
      ? [request?.ownerDshSessionId, record(request?.filter)?.ownerDshSessionId]
      : []),
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
      typeof Reflect.get(candidate as object, 'registerSessionAdmission') !== 'function' ||
      typeof Reflect.get(candidate as object, 'registerSessionResultProjection') !== 'function'
    )
      throw new Error('Zhuma requires the matching Session admission runtime patch.');
    const gateway = candidate as SessionGateway;
    let active = true;
    const dispose = gateway.registerSessionAdmission(async (method, args, signal) => {
      signal.throwIfAborted();
      const source = current();
      if (closed || !active || !source) return false;
      if (method.startsWith('dshAcp/')) {
        const name = method.slice(7);
        if (!acpCatalogMethods.has(name)) {
          const fields = acpSessionArgs[name];
          if (!fields || fields.some((key) => typeof args[key] !== 'string' || !args[key]))
            return false;
        }
      }
      for (const id of nativeSessionCommandIds(args, method)) {
        const result = await source.lookupNativeSession(id);
        signal.throwIfAborted();
        if (result !== null) return false;
      }
      return !closed && active && current() === source;
    });
    let disposeProjection: () => void;
    try {
      disposeProjection = gateway.registerSessionResultProjection((method, _args, signal) => {
        const source = current();
        const assertCurrent = () => {
          signal.throwIfAborted();
          if (closed || !active || !source || current() !== source)
            throw new Error('Session catalog projection is unavailable.');
        };
        assertCurrent();
        return prepareHostAcpSessionProjection(method, source!, assertCurrent, signal);
      });
    } catch (error) {
      active = false;
      dispose();
      throw error;
    }
    const stop = () => {
      active = false;
      stops.delete(stop);
      dispose();
      disposeProjection();
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
