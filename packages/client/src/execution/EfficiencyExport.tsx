import { useState } from 'react';
import { ActionMenu } from '../workbench/ActionMenu.js';
import {
  readEfficiencyExport,
  saveEfficiencyFile,
  type EfficiencyExportFormat,
} from './efficiency-export.js';

/** 一键下载已记录的效率数字。不是指标看板。 */
export function EfficiencyExportControls({
  fetcher = globalThis.fetch,
}: {
  fetcher?: typeof fetch;
}) {
  const [busy, setBusy] = useState<EfficiencyExportFormat | null>(null);
  const [message, setMessage] = useState('');
  async function download(format: EfficiencyExportFormat) {
    if (busy) return;
    setBusy(format);
    setMessage('');
    try {
      const exported = await readEfficiencyExport(fetcher, format);
      saveEfficiencyFile(exported);
      setMessage(format === 'json' ? '已导出 JSON。' : '已导出 CSV。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '效率导出失败。');
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="zm-efficiency-export">
      <ActionMenu
        label="导出"
        busy={busy !== null}
        busyLabel="正在导出…"
        items={[
          { label: '导出 JSON', onSelect: () => void download('json') },
          { label: '导出 CSV', onSelect: () => void download('csv') },
        ]}
      />
      {message ? <p role="status">{message}</p> : null}
    </div>
  );
}
