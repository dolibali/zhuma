/** 一次用户 MCP 工具调用的可回放记录。只追加，不改已有条目。 */
export interface McpCallRecord {
  readonly serverId: string;
  readonly toolName: string;
  readonly argsSummary: string;
  readonly outcome: 'ok' | 'fail';
  readonly durationMs: number;
  /** 失败时的稳定错误码。成功记录不带这个字段。 */
  readonly errorCode?: string;
}

export interface McpCallLog {
  readonly records: readonly McpCallRecord[];
}

export interface McpCallQuery {
  readonly serverId?: string;
}

export function createMcpCallLog(): McpCallLog {
  return Object.freeze({ records: Object.freeze([]) });
}

/**
 * 追加一条调用记录。返回新日志，原日志保持不变。
 * 空服务器、空工具名、非法耗时，或成功却带错误码时拒绝写入。
 */
export function appendMcpCall(log: McpCallLog, record: McpCallRecord): McpCallLog {
  const stored = freezeRecord(record);
  return Object.freeze({
    records: Object.freeze([...log.records, stored]),
  });
}

/** 读取调用记录。传入 serverId 时只返回该连接的记录。 */
export function readMcpCalls(log: McpCallLog, query: McpCallQuery = {}): readonly McpCallRecord[] {
  if (query.serverId === undefined) return log.records;
  return Object.freeze(log.records.filter((item) => item.serverId === query.serverId));
}

function freezeRecord(record: McpCallRecord): McpCallRecord {
  const problem = invalid(record);
  if (problem !== null) throw new Error(`MCP 调用日志无效：${problem}`);
  const stored: McpCallRecord = {
    serverId: record.serverId,
    toolName: record.toolName,
    argsSummary: record.argsSummary,
    outcome: record.outcome,
    durationMs: record.durationMs,
    ...(record.errorCode !== undefined ? { errorCode: record.errorCode } : {}),
  };
  return Object.freeze(stored);
}

function invalid(record: McpCallRecord): string | null {
  if (record.serverId.trim().length === 0) return 'serverId';
  if (record.toolName.trim().length === 0) return 'toolName';
  if (record.outcome !== 'ok' && record.outcome !== 'fail') return 'outcome';
  if (typeof record.argsSummary !== 'string') return 'argsSummary';
  if (!Number.isFinite(record.durationMs) || record.durationMs < 0) return 'durationMs';
  if (record.outcome === 'ok' && record.errorCode !== undefined) return 'errorCode';
  if (record.outcome === 'fail' && (record.errorCode?.trim().length ?? 0) === 0) return 'errorCode';
  return null;
}
