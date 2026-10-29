import { Button } from '../workbench/Button.js';
import { SingleSelect } from '../workbench/SingleSelect.js';
import type { WorkspacePublishRange } from './workspace-approvals.js';

/** Shared explicit relative-path controls; callers own the original frozen permission. */
export function WorkspacePublishRanges({
  ranges,
  disabled,
  valid,
  onChange,
  defaultKind = 'file',
}: {
  ranges: readonly WorkspacePublishRange[];
  disabled: boolean;
  valid: boolean;
  onChange(ranges: WorkspacePublishRange[]): void;
  defaultKind?: WorkspacePublishRange['kind'];
}) {
  return (
    <div className="zm-workspace-publish">
      {!valid && <p role="alert">请填写工作区内的相对路径，例如 deliverables/report.md。</p>}
      {!ranges.length && (
        <p className="zm-muted">添加相对路径后，Agent 才能把这些本机文件提交给团队。</p>
      )}
      {ranges.map((range, index) => (
        <div className="zm-workspace-publish-row" key={index}>
          <SingleSelect
            label={`第 ${index + 1} 项交付范围类型`}
            value={range.kind}
            disabled={disabled}
            options={[
              { value: 'file', label: '文件' },
              { value: 'directory', label: '目录' },
            ]}
            onValueChange={(kind) =>
              onChange(
                ranges.map((item, at) =>
                  at === index
                    ? { ...item, kind: kind === 'directory' ? 'directory' : 'file' }
                    : item,
                ),
              )
            }
          />
          <input
            aria-label={`第 ${index + 1} 项相对路径`}
            value={range.path}
            disabled={disabled}
            placeholder="例如 deliverables/report.md"
            maxLength={512}
            onChange={(event) =>
              onChange(
                ranges.map((item, at) =>
                  at === index ? { ...item, path: event.currentTarget.value } : item,
                ),
              )
            }
          />
          {!disabled && (
            <Button onClick={() => onChange(ranges.filter((_, at) => at !== index))}>移除</Button>
          )}
        </div>
      ))}
      {!disabled && (
        <Button
          disabled={ranges.length >= 16}
          onClick={() => onChange([...ranges, { kind: defaultKind, path: '' }])}
        >
          添加范围
        </Button>
      )}
    </div>
  );
}
