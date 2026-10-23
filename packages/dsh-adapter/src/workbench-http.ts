/** A streaming Connection route owns its body budget; it must not cancel the Node
 * request before the bridge has flushed its rejection response. */
export const WORKBENCH_HTTP_LIMITS = Object.freeze({
  bodyBytes: 8 * 1024 * 1024,
  bodyTimeoutMs: 10_000,
});
export interface WorkbenchHttpLimits {
  readonly bodyBytes: number;
  readonly bodyTimeoutMs: number;
}
export class WorkbenchBodyError extends Error {
  constructor(public readonly status: 400 | 408 | 413) {
    super('Workbench request body rejected');
  }
}

export async function readWorkbenchBody(
  request: Request,
  limits: WorkbenchHttpLimits,
): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > limits.bodyBytes))
    throw new WorkbenchBodyError(413);
  if (!request.body) throw new WorkbenchBodyError(400);
  const reader = request.body.getReader();
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(limits.bodyTimeoutMs)]);
  let rejectAbort: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(new WorkbenchBodyError(408));
  });
  signal.addEventListener('abort', rejectAbort!, { once: true });
  try {
    signal.throwIfAborted();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    let text = '';
    for (;;) {
      const next = await Promise.race([reader.read(), interrupted]);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limits.bodyBytes) throw new WorkbenchBodyError(413);
      text += decoder.decode(next.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } catch (error) {
    if (error instanceof WorkbenchBodyError) throw error;
    throw new WorkbenchBodyError(signal.aborted ? 408 : 400);
  } finally {
    signal.removeEventListener('abort', rejectAbort!);
    // cancel() would destroy IncomingMessage/socket before Connection writes 4xx.
    reader.releaseLock();
  }
}
