import { useEffect, useRef, useState } from 'react';
import type { ArtifactFileRef } from '@zhuma/agent-core';
import {
  executionErrorMessage,
  type ExecutionApi,
  type ExecutionNodeWire,
  type SavedDeliveryDraftWire,
} from './ExecutionApi.js';
import { nodeIdentity } from './interaction.js';

type Values = { text: string; link: string; files: readonly ArtifactFileRef[] };
type Operation = { context: string; abort: AbortController; kind: 'read' | 'save' | 'submit' };
const empty = (): Values => ({ text: '', link: '', files: [] });
export const deliveryLinks = (link: string) =>
  link
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean);
const content = (form: Values) => ({
  text: form.text,
  links: deliveryLinks(form.link),
  files: form.files,
});
const same = (form: Values, saved: SavedDeliveryDraftWire) =>
  JSON.stringify(content(form)) ===
  JSON.stringify({ text: saved.text, links: saved.links, files: saved.files });

/** One operation lane, independent server draft versions, and receipts bound to the presented node/round. */
export function useDeliveryEditor(
  api: ExecutionApi,
  node: ExecutionNodeWire,
  available: boolean,
  onSubmitted: (node: ExecutionNodeWire) => void,
) {
  const context = JSON.stringify([
    nodeIdentity(node),
    node.version,
    node.status,
    node.currentRoundId ?? null,
  ]);
  const scope = useRef({ context });
  if (scope.current.context !== context) scope.current = { context };
  const lifetime = scope.current;
  const mounted = useRef(false);
  const active = useRef<Operation>();
  const [operation, setOperation] = useState<Operation>();
  const [values, setValues] = useState<Values>(empty);
  const form = useRef(values);
  form.current = values;
  const touched = useRef({ text: false, link: false, files: false });
  const removedFiles = useRef(new Set<string>());
  const [stored, setStored] = useState<{ context: string; value: SavedDeliveryDraftWire }>();
  const [proposal, setProposal] = useState<{ context: string; value: SavedDeliveryDraftWire }>();
  const [failure, setFailure] = useState<{ context: string; message: string; conflict: boolean }>();
  const [completed, setCompleted] = useState<string>();
  const retry = useRef({ fingerprint: '', key: '' });
  const saved = stored?.context === context ? stored.value : undefined;
  const candidate = proposal?.context === context ? proposal.value : undefined;
  const error = failure?.context === context ? failure.message : '';
  const conflict = failure?.context === context && failure.conflict;
  const submitted = completed === context;
  const pending = operation?.context === context ? operation.kind : '';
  const dirty = saved
    ? !same(values, saved)
    : !!(values.text || values.link || values.files.length);
  function update(next: Values) {
    form.current = next;
    setValues(next);
  }
  function edit(field: 'text' | 'link', value: string) {
    touched.current[field] = true;
    update({ ...form.current, [field]: value });
  }
  function removeFile(index: number) {
    if (!saved || active.current?.context === context || submitted) return;
    touched.current.files = true;
    const removed = form.current.files[index];
    if (removed) removedFiles.current.add(JSON.stringify(removed));
    update({ ...form.current, files: form.current.files.filter((_, i) => i !== index) });
  }
  const current = (op: Operation) =>
    mounted.current &&
    scope.current === lifetime &&
    active.current === op &&
    !op.abort.signal.aborted;
  function begin(kind: Operation['kind']) {
    if (!mounted.current || scope.current !== lifetime || !available || submitted) return;
    if (active.current?.context === context) return;
    active.current?.abort.abort();
    const op = { context, kind, abort: new AbortController() };
    active.current = op;
    setOperation(op);
    return op;
  }
  function finish(op: Operation) {
    if (!current(op)) return;
    active.current = undefined;
    setOperation(undefined);
  }
  function fail(op: Operation, error: unknown) {
    if (!current(op)) return;
    const isConflict =
      op.kind === 'save' &&
      !!error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'conflict';
    setFailure({
      context,
      message: executionErrorMessage(error),
      conflict: isConflict || !!conflict,
    });
  }
  const query = {
    taskId: node.taskId,
    planId: node.planId,
    revision: node.revision,
    nodeId: node.nodeId,
  };
  async function read(recover = false) {
    const op = begin('read');
    if (!op) return;
    // A conflict stays unresolved until the user chooses the version to keep.
    setFailure(conflict ? failure : undefined);
    try {
      const value = await api.readDeliveryDraft(query, op.abort.signal);
      if (!current(op)) return;
      if (recover) {
        setProposal({ context, value });
        if (saved && JSON.stringify(saved) !== JSON.stringify(value))
          setFailure({
            context,
            message: '已存草稿已有更新，请选择恢复或保留当前修改。',
            conflict: true,
          });
      } else {
        setStored({ context, value });
        update({
          text: touched.current.text ? form.current.text : value.text,
          link: touched.current.link ? form.current.link : value.links.join('\n'),
          files: value.files.filter((file) => !removedFiles.current.has(JSON.stringify(file))),
        });
        if (
          (touched.current.text || touched.current.link || touched.current.files) &&
          (value.text || value.links.length || value.files.length)
        )
          setProposal({ context, value });
      }
    } catch (error) {
      fail(op, error);
    } finally {
      finish(op);
    }
  }
  useEffect(() => {
    mounted.current = true;
    if (available) void read();
    return () => {
      mounted.current = false;
      active.current?.abort.abort();
      active.current = undefined;
    };
  }, [api, context, available]);

  function resolve(choice: 'restore' | 'keep' | 'cancel') {
    if (!candidate || active.current?.context === context || submitted) return;
    if (choice !== 'cancel') {
      if (choice === 'restore') {
        removedFiles.current.clear();
        touched.current = { text: true, link: true, files: true };
        update({ text: candidate.text, link: candidate.links.join('\n'), files: candidate.files });
      } else {
        const textEdited = saved ? form.current.text !== saved.text : touched.current.text;
        const linksEdited = saved
          ? JSON.stringify(deliveryLinks(form.current.link)) !== JSON.stringify(saved.links)
          : touched.current.link;
        update({
          text: textEdited ? form.current.text : candidate.text,
          link: linksEdited ? form.current.link : candidate.links.join('\n'),
          files: candidate.files.filter((file) => !removedFiles.current.has(JSON.stringify(file))),
        });
      }
      setStored({ context, value: candidate });
      setFailure(undefined);
    }
    setProposal(undefined);
  }
  function validate(submit: boolean) {
    const payload = content(form.current);
    let message = '';
    if (submit && !payload.text.trim() && !payload.links.length)
      message = '请填写产物正文或添加链接。';
    else if (payload.links.length > 20) message = '最多添加 20 个链接，每行一个。';
    else if (
      submit &&
      payload.links.some((link) => {
        try {
          const url = new URL(link);
          return !['http:', 'https:'].includes(url.protocol) || !!url.username || !!url.password;
        } catch {
          return true;
        }
      })
    )
      message = '最多添加 20 个 http 或 https 链接，每行一个。';
    else if (
      !submit &&
      (payload.links.some((link) => link.length > 2048) || payload.links.join('').length > 8192)
    )
      message = '草稿单条链接最多 2048 个字符，链接合计最多 8192 个字符。';
    if (message) {
      setFailure({ context, message, conflict: false });
      return;
    }
    return payload;
  }
  const canWrite = available && !submitted && !!saved && !pending && !candidate && !conflict;
  async function write(kind: 'save' | 'submit') {
    if (!canWrite || !saved || active.current?.context === context) return;
    if (
      kind === 'submit' &&
      (node.inputs?.some((input) => input.blocking) || form.current.files.length)
    )
      return;
    const payload = validate(kind === 'submit');
    if (!payload) return;
    const op = begin(kind);
    if (!op) return;
    setFailure(undefined);
    const request = {
      ...query,
      expectedVersion: kind === 'save' ? saved.version : node.version,
      ...payload,
    };
    const fingerprint = JSON.stringify({ kind, ...request });
    if (retry.current.fingerprint !== fingerprint)
      retry.current = { fingerprint, key: crypto.randomUUID() };
    const body = { ...request, idempotencyKey: retry.current.key };
    try {
      if (kind === 'save') {
        const value = await api.saveDeliveryDraft(body, op.abort.signal);
        if (!current(op)) return;
        setStored({ context, value });
        removedFiles.current.clear();
        touched.current.files = false;
      } else {
        const next = await api.submit(body, op.abort.signal);
        if (!current(op)) return;
        removedFiles.current.clear();
        touched.current = { text: false, link: false, files: false };
        update(empty());
        setCompleted(context);
        setStored(undefined);
        setProposal(undefined);
        onSubmitted(next);
      }
      retry.current = { fingerprint: '', key: '' };
    } catch (error) {
      fail(op, error);
    } finally {
      finish(op);
    }
  }
  return {
    values,
    edit,
    removeFile,
    saved,
    candidate,
    resolve,
    error,
    conflict,
    pending,
    dirty,
    submitted,
    canWrite,
    read: () => read(true),
    save: () => write('save'),
    submit: () => write('submit'),
  };
}
