export interface CodeArtsSetupApi {
  status(signal: AbortSignal): Promise<{ configured: boolean }>;
  configure(command: string, signal: AbortSignal): Promise<{ configured: true }>;
}
const messages: Record<string, string> = {
  'active-sessions': '请先结束正在使用的 ACP 会话，再更改码道配置。',
  'command-not-found': '未找到可执行的码道命令，请检查安装位置。',
  'invalid-input': '请输入命令名或完整路径，参数无需填写。',
  incomplete: '配置尚未完成，请重新保存。',
  'untrusted-request': '请在本机 Zhuma 桌面配置码道。',
};
class SetupResponseError extends Error {}
const invalid = () => new SetupResponseError('本机码道配置返回不完整，请重新保存。');
/** Explicit local owner settings. Never forwarded to the team backend. */
export function createCodeArtsSetupApi(
  localFetch: typeof fetch,
  isCurrent: () => boolean,
): CodeArtsSetupApi {
  async function invoke(endpoint: 'status' | 'configure', signal: AbortSignal, command?: string) {
    const current = () => {
      signal.throwIfAborted();
      if (!isCurrent()) throw new DOMException('View changed', 'AbortError');
    };
    current();
    const response = await localFetch(`/api/zhuma-codearts/${endpoint}`, {
      method: endpoint === 'status' ? 'GET' : 'POST',
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      signal,
      ...(command === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command }) }),
    });
    const reader = response.body?.getReader();
    const cancel = () => {
      void reader?.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      current();
      if (!reader || response.headers.get('content-type')?.split(';')[0] !== 'application/json')
        throw invalid();
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const chunk = await reader.read();
        current();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 16384) throw invalid();
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const wire: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!wire || typeof wire !== 'object' || !('ok' in wire)) throw invalid();
      if (wire.ok !== true)
        throw new SetupResponseError(
          messages['code' in wire && typeof wire.code === 'string' ? wire.code : ''] ??
            '本机码道配置暂不可用，请稍后重试。',
        );
      if (
        !response.ok ||
        !('value' in wire) ||
        !wire.value ||
        typeof wire.value !== 'object' ||
        !('configured' in wire.value) ||
        typeof wire.value.configured !== 'boolean'
      )
        throw invalid();
      if (endpoint === 'configure' && !wire.value.configured) throw invalid();
      return { configured: wire.value.configured };
    } catch (error) {
      current();
      throw error instanceof SetupResponseError ? error : invalid();
    } finally {
      signal.removeEventListener('abort', cancel);
      await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
    }
  }
  return {
    status: (signal) => invoke('status', signal),
    configure: async (command, signal) => {
      await invoke('configure', signal, command);
      return { configured: true };
    },
  };
}
