export type EfficiencyExportFormat = 'json' | 'csv';

export interface EfficiencyExportFile {
  readonly format: EfficiencyExportFormat;
  readonly filename: string;
  readonly document: string;
}

const FILE = /^efficiency-metrics\.(json|csv)$/;

function invalid(): never {
  throw new Error('效率导出结果无效。');
}

function file(value: unknown, format: EfficiencyExportFormat): EfficiencyExportFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (record.format !== format) invalid();
  if (typeof record.filename !== 'string' || !FILE.test(record.filename)) invalid();
  if (record.format === 'json' && record.filename !== 'efficiency-metrics.json') invalid();
  if (record.format === 'csv' && record.filename !== 'efficiency-metrics.csv') invalid();
  if (typeof record.document !== 'string') invalid();
  return { format, filename: record.filename, document: record.document };
}

/** 读取一份已记录事件的 JSON 或 CSV。不在客户端汇总，也不把空历时写成 0。 */
export async function readEfficiencyExport(
  fetcher: typeof fetch,
  format: EfficiencyExportFormat,
  taskId?: string,
  signal?: AbortSignal,
): Promise<EfficiencyExportFile> {
  const rpcId = crypto.randomUUID();
  const response = await fetcher('/api/zhuma-efficiency/export', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method: 'zhuma-efficiency/export',
      payload: { format, ...(taskId === undefined ? {} : { taskId }) },
    }),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw new Error('效率导出暂不可用，请重试。');
  const envelope: unknown = await response.json();
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) invalid();
  const body = envelope as Record<string, unknown>;
  if (body.type !== 'server-response' || body.rpcId !== rpcId) invalid();
  const result = body.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) invalid();
  const outcome = result as { ok?: unknown; value?: unknown };
  if (outcome.ok !== true) throw new Error('效率导出没有被接受。');
  return file(outcome.value, format);
}

/** 浏览器下载。调用方已经拿到文档正文。 */
export function saveEfficiencyFile(exported: EfficiencyExportFile): void {
  const blob = new Blob([exported.document], {
    type: exported.format === 'json' ? 'application/json' : 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = exported.filename;
  link.click();
  URL.revokeObjectURL(url);
}
