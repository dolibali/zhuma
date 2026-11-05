import { useState } from 'react';
import { Button } from '../workbench/Button.js';
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
    <div className="zm-actions">
      <Button variant="quiet" busy={busy === 'json'} onClick={() => void download('json')}>
        导出效率 JSON
      </Button>
      <Button variant="quiet" busy={busy === 'csv'} onClick={() => void download('csv')}>
        导出效率 CSV
      </Button>
      {message ? <p role="status">{message}</p> : null}
    </div>
  );
}
