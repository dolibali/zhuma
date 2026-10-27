import { FileReferences } from './FileReferences.js';
import type { FileTarget } from './files.js';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../workbench/Button.js';
import { ControlIcon } from '../workbench/ControlIcon.js';
import {
  executionErrorMessage,
  type ExecutionApi,
  type ExecutionNodeWire,
  type UpstreamContentWire,
  type UpstreamInputWire,
} from './ExecutionApi.js';
import { nodeIdentity, useFormKey } from './interaction.js';

type VisibleInput = Extract<UpstreamInputWire, { access: 'visible' }>;
type Props = { api: ExecutionApi; node: ExecutionNodeWire; input: VisibleInput };
type Reading =
  | { kind: 'loading' }
  | { kind: 'ready'; value: UpstreamContentWire }
  | { kind: 'error'; message: string };

/** Discard open content on any API, node generation or pinned-reference change. */
export function UpstreamContent(props: Props) {
  const { api, node, input } = props;
  const key = useFormKey(
    api,
    JSON.stringify([
      nodeIdentity(node),
      node.version,
      node.status,
      node.currentRoundId ?? null,
      input.sourceNodeId,
      input.artifactVersionId,
      input.version,
    ]),
  );
  return <Disclosure key={key} {...props} />;
}

function Disclosure(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="zm-upstream-disclosure"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary
        aria-label={`${open ? '收起' : '查看'}${props.input.sourceGoal || props.input.sourceNodeId}第 ${props.input.version} 版内容`}
      >
        <ControlIcon direction={open ? 'down' : 'right'} />
        <span>{open ? '收起内容' : '查看内容'}</span>
      </summary>
      {open && <ContentRead {...props} />}
    </details>
  );
}

/** Mounted only while explicitly open. Closing aborts and reopening reads again. */
function ContentRead({ api, node, input }: Props) {
  const [reading, setReading] = useState<Reading>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const active = useRef<AbortController>();
  useEffect(() => {
    const request = new AbortController();
    active.current = request;
    const current = () => active.current === request && !request.signal.aborted;
    setReading({ kind: 'loading' });
    void api
      .upstreamContent(
        {
          taskId: node.taskId,
          planId: node.planId,
          revision: node.revision,
          nodeId: node.nodeId,
          sourceNodeId: input.sourceNodeId,
          artifactVersionId: input.artifactVersionId,
          expectedArtifactVersion: input.version,
        },
        request.signal,
      )
      .then(
        (value) => {
          if (current()) setReading({ kind: 'ready', value });
        },
        (error: unknown) => {
          if (current()) setReading({ kind: 'error', message: executionErrorMessage(error) });
        },
      );
    return () => {
      active.current = undefined;
      request.abort();
    };
  }, [
    api,
    node.taskId,
    node.planId,
    node.revision,
    node.nodeId,
    input.sourceNodeId,
    input.artifactVersionId,
    input.version,
    attempt,
  ]);
  return reading.kind === 'loading' ? (
    <p role="status">正在读取…</p>
  ) : reading.kind === 'error' ? (
    <div className="zm-upstream-error">
      <p role="alert">{reading.message}</p>
      <Button variant="quiet" onClick={() => setAttempt((value) => value + 1)}>
        重试读取
      </Button>
    </div>
  ) : (
    <UpstreamContentBody
      content={reading.value.content}
      api={api}
      target={{
        taskId: node.taskId,
        planId: node.planId,
        revision: node.revision,
        nodeId: node.nodeId,
        purpose: 'upstream',
        sourceNodeId: input.sourceNodeId,
        artifactVersionId: input.artifactVersionId,
      }}
    />
  );
}

/** Plain text only; never execute uploaded content or manufacture a file URL. */
export function UpstreamContentBody({
  content,
  api,
  target,
}: {
  content: UpstreamContentWire['content'];
  api?: ExecutionApi | undefined;
  target?: FileTarget | undefined;
}) {
  const heading = useId();
  return (
    <section className="zm-upstream-content" aria-labelledby={heading}>
      <h4 id={heading}>已接受内容</h4>
      <div
        className="zm-upstream-body zm-execution-text"
        tabIndex={0}
        role="region"
        aria-label="上游正文"
      >
        {content.text || '无文字正文'}
      </div>
      {!!content.links.length && (
        <ul className="zm-upstream-links" aria-label="参考链接">
          {content.links.map((link, index) => {
            let safe = false;
            try {
              const url = new URL(link);
              safe = ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
            } catch {
              /* Unsafe links remain text. */
            }
            return (
              <li key={index}>
                {safe ? (
                  <a href={link} target="_blank" rel="noopener noreferrer">
                    {link}
                  </a>
                ) : (
                  <span>{link}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {api && target ? (
        <FileReferences api={api} files={content.files} target={target} />
      ) : (
        !!content.files.length && (
          <div className="zm-upstream-files">
            <h4>文件信息</h4>
            <ul>
              {content.files.map((file) => (
                <li key={file.id}>
                  <strong>{file.id}</strong>
                  <span>
                    {file.mediaType} · {file.byteSize.toLocaleString()} 字节
                  </span>
                </li>
              ))}
            </ul>
            <p className="zm-muted">文件内容暂不可查看。</p>
          </div>
        )
      )}
    </section>
  );
}
