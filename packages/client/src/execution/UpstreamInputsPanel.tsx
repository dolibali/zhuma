import { useId } from 'react';
import type { ExecutionApi, ExecutionNodeWire, UpstreamInputWire } from './ExecutionApi.js';
import { UpstreamContent } from './UpstreamContent.js';

/** The service owns visibility; only visible pinned references offer an explicit read. */
export function UpstreamInputsPanel({
  inputs,
  api,
  node,
}: {
  inputs?: readonly UpstreamInputWire[] | undefined;
  api?: ExecutionApi;
  node?: ExecutionNodeWire;
}) {
  const heading = useId();
  return (
    <section className="zm-upstream-inputs" aria-labelledby={heading}>
      <h3 id={heading}>上游输入</h3>
      {inputs === undefined ? (
        <p className="zm-muted">上游输入尚未返回，可刷新待办重试。</p>
      ) : inputs.length === 0 ? (
        <p className="zm-muted">没有上游输入。</p>
      ) : (
        <ul>
          {inputs.map((input, index) => (
            <li key={index}>
              <div className="zm-upstream-heading">
                <strong>
                  {input.access === 'hidden'
                    ? `${input.count} 个受限来源`
                    : input.access === 'visible'
                      ? input.sourceGoal || input.sourceNodeId
                      : input.sourceNodeId}
                </strong>
                <span className={input.blocking ? 'zm-status' : 'zm-kind'}>
                  {input.blocking ? '阻塞提交' : input.access === 'visible' ? '已接受' : '提示'}
                </span>
              </div>
              {input.access === 'visible' ? (
                <>
                  <div className="zm-upstream-meta">
                    {input.sourceGoal && <span>节点 {input.sourceNodeId}</span>}
                    <span>
                      {input.name === `第 ${input.version} 版`
                        ? input.name
                        : `第 ${input.version} 版 · ${input.name}`}
                    </span>
                  </div>
                  {api && node && <UpstreamContent api={api} node={node} input={input} />}
                </>
              ) : (
                <p>{input.message}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
