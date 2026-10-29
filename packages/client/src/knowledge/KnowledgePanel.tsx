import { useEffect, useId, useRef, useState } from 'react';
import {
  KNOWLEDGE_LIMITS,
  KnowledgeDraftContentSchema,
  type KnowledgeDraftContent,
  type KnowledgeDraftSummary,
  type KnowledgeLibrary,
  type KnowledgePageSummary,
  type KnowledgeReadValue,
  type KnowledgeVersionRef,
} from '@zhuma/agent-core';
import type { MemberSpaceLifetime } from '../identity/MemberSpaceBoundary.js';
import { Button } from '../workbench/Button.js';
import { Modal } from '../workbench/controls.js';
import { SingleSelect } from '../workbench/SingleSelect.js';
import { useUnsavedChanges } from '../workbench/UnsavedChanges.js';
import { KnowledgeClientError, type KnowledgeApi } from './api.js';

export interface KnowledgePanelProps {
  readonly api: KnowledgeApi;
  readonly actorId: string;
  readonly spaceId: string;
  readonly lifetime: MemberSpaceLifetime;
  readonly onDirtyChange?: (dirty: boolean) => void;
}
type Row =
  | { kind: 'published'; page: KnowledgePageSummary; snippet?: string }
  | { kind: 'draft'; page: KnowledgeDraftSummary };
type Browse = {
  phase: 'loading' | 'ready' | 'error';
  mode: 'published' | 'drafts';
  query: string;
  rows: Row[];
  nextCursor: string | null;
  error: string;
};
type Reader = {
  kind: 'reader';
  phase: 'loading' | 'ready' | 'error';
  reference: KnowledgeVersionRef;
  ownerActorId?: string;
  title: string;
  text: string;
  nextOffset: number;
  totalBytes: number;
  sources: KnowledgeVersionRef[];
  error: string;
};
type Editor = {
  kind: 'editor';
  pageId: string;
  revision: number;
  content: KnowledgeDraftContent;
  savedKey: string;
  published: KnowledgeVersionRef | null;
  authorship: 'member' | 'agent';
  hasDraft: boolean;
  error: string;
};
type View = { kind: 'empty' } | Reader | Editor;
type Ticket = { controller: AbortController; lifetime: MemberSpaceLifetime };
const emptyBrowse = (): Browse => ({
  phase: 'loading',
  mode: 'published',
  query: '',
  rows: [],
  nextCursor: null,
  error: '',
});
const refKey = (ref: KnowledgeVersionRef) =>
  JSON.stringify([ref.spaceId, ref.libraryId, ref.pageId, ref.version, ref.checksum]);
const contentKey = (content: KnowledgeDraftContent) =>
  JSON.stringify([
    content.title,
    content.format,
    content.text,
    content.originalText ?? null,
    content.sources.map(refKey),
  ]);
const rowKey = (row: Row) =>
  row.kind === 'published'
    ? `published:${refKey(row.page.reference)}`
    : `draft:${row.page.pageId}:${row.page.pageRevision}`;
function reject(): never {
  throw new KnowledgeClientError('invalid-response');
}
const encoder = new TextEncoder();
async function checksum(text: string): Promise<string> {
  const result = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function message(error: unknown): string {
  return error instanceof KnowledgeClientError ? error.message : '暂时无法读取或保存资料，请重试。';
}

/** Ephemeral view state only. Every operation still uses the member/space service. */
export function KnowledgePanel(props: KnowledgePanelProps) {
  const owner = useRef({
    api: props.api,
    actorId: props.actorId,
    spaceId: props.spaceId,
    lifetime: props.lifetime,
    epoch: 0,
  });
  const previous = owner.current;
  if (
    previous.api !== props.api ||
    previous.actorId !== props.actorId ||
    previous.spaceId !== props.spaceId ||
    !previous.lifetime.isCurrent()
  )
    owner.current = {
      api: props.api,
      actorId: props.actorId,
      spaceId: props.spaceId,
      lifetime: props.lifetime,
      epoch: previous.epoch + 1,
    };
  else previous.lifetime = props.lifetime;
  const currentOwner = owner.current;
  return (
    <OwnedKnowledgePanel
      key={currentOwner.epoch}
      {...props}
      owns={() => owner.current === currentOwner}
    />
  );
}

function OwnedKnowledgePanel({
  api,
  actorId,
  spaceId,
  lifetime,
  onDirtyChange,
  owns,
}: KnowledgePanelProps & { owns(): boolean }) {
  const heading = useId(),
    titleId = useId(),
    bodyId = useId(),
    cancelId = useId();
  const latest = useRef({ lifetime, onDirtyChange, owns });
  latest.current = { lifetime, onDirtyChange, owns };
  const alive = useRef(false),
    listTicket = useRef<Ticket>(),
    detailTicket = useRef<Ticket>();
  const libraryRef = useRef<KnowledgeLibrary>();
  const [library, setLibrary] = useState<KnowledgeLibrary>();
  const [browse, setBrowse] = useState<Browse>(emptyBrowse),
    browseRef = useRef(browse);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View>({ kind: 'empty' }),
    viewRef = useRef(view);
  const [busy, setBusy] = useState(false),
    busyRef = useRef(false);
  const [notice, setNotice] = useState('');
  const [confirmation, setConfirmation] = useState<{ action(): void; restoreFocus(): void }>();
  const attempts = useRef(new Map<string, string>()),
    inputEpoch = useRef(0);
  const fenceEpoch = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirty = view.kind === 'editor' && contentKey(view.content) !== view.savedKey;
  useUnsavedChanges(dirty);
  useEffect(() => {
    latest.current.onDirtyChange?.(dirty);
  }, [dirty]);
  useEffect(() => () => latest.current.onDirtyChange?.(false), []);

  function putBrowse(value: Browse) {
    browseRef.current = value;
    setBrowse(value);
  }
  function putView(value: View) {
    viewRef.current = value;
    setView(value);
  }
  function putBusy(value: boolean) {
    busyRef.current = value;
    setBusy(value);
  }
  function start(channel: 'list' | 'detail'): Ticket {
    const slot = channel === 'list' ? listTicket : detailTicket;
    slot.current?.controller.abort();
    const ticket = { controller: new AbortController(), lifetime: latest.current.lifetime };
    slot.current = ticket;
    return ticket;
  }
  function current(ticket: Ticket, channel: 'list' | 'detail'): boolean {
    return (
      alive.current &&
      latest.current.owns() &&
      ticket.lifetime.isCurrent() &&
      latest.current.lifetime.isCurrent() &&
      !ticket.controller.signal.aborted &&
      (channel === 'list' ? listTicket : detailTicket).current === ticket
    );
  }
  function check(ticket: Ticket, channel: 'list' | 'detail' = 'detail') {
    if (!current(ticket, channel)) throw new DOMException('Knowledge view changed', 'AbortError');
  }
  function echo(value: { actorId: string; spaceId: string }) {
    if (value.actorId !== actorId || value.spaceId !== spaceId) reject();
  }
  function exact(ref: KnowledgeVersionRef) {
    if (ref.spaceId !== spaceId || ref.libraryId !== libraryRef.current?.id) reject();
  }
  function fence(error: unknown): boolean {
    if (
      !(error instanceof KnowledgeClientError) ||
      !['unauthenticated', 'forbidden', 'not-found', 'invalid-response'].includes(error.code)
    )
      return false;
    fenceEpoch.current++;
    listTicket.current?.controller.abort();
    detailTicket.current?.controller.abort();
    libraryRef.current = undefined;
    setLibrary(undefined);
    setConfirmation(undefined);
    putBusy(false);
    putView({ kind: 'empty' });
    setQuery('');
    putBrowse({ ...emptyBrowse(), phase: 'error', error: message(error) });
    if (error.code === 'unauthenticated' && latest.current.lifetime.isCurrent())
      latest.current.lifetime.onUnauthenticated();
    return true;
  }
  function choose(action: () => void) {
    if (busyRef.current || !libraryRef.current || !latest.current.lifetime.isCurrent()) return;
    const epoch = fenceEpoch.current;
    const guarded = () => {
      if (
        epoch === fenceEpoch.current &&
        libraryRef.current &&
        latest.current.owns() &&
        latest.current.lifetime.isCurrent()
      )
        action();
    };
    const before = viewRef.current;
    if (before.kind === 'editor' && contentKey(before.content) !== before.savedKey) {
      const focus = document.activeElement;
      setConfirmation({
        action: guarded,
        restoreFocus: () => {
          if (focus instanceof HTMLElement) focus.focus();
        },
      });
    } else guarded();
  }

  async function loadRows(mode: Browse['mode'], phrase = '', more = false) {
    const target = libraryRef.current;
    if (!target || !alive.current || !latest.current.lifetime.isCurrent()) return;
    const previous = browseRef.current;
    if (more && (!previous.nextCursor || previous.mode !== mode || previous.query !== phrase))
      return;
    const ticket = start('list'),
      signal = ticket.controller.signal;
    putBrowse({
      phase: 'loading',
      mode,
      query: phrase,
      rows: more ? previous.rows : [],
      nextCursor: more ? previous.nextCursor : null,
      error: '',
    });
    try {
      let rows: Row[], nextCursor: string | null;
      const request = {
        spaceId,
        libraryId: target.id,
        limit: 20,
        ...(more && previous.nextCursor ? { cursor: previous.nextCursor } : {}),
      };
      if (mode === 'drafts') {
        const value = await api.drafts(request, signal);
        check(ticket, 'list');
        echo(value);
        if (
          value.libraryId !== target.id ||
          value.pages.some(
            (page) =>
              page.spaceId !== spaceId ||
              page.libraryId !== target.id ||
              page.ownerActorId !== actorId,
          )
        )
          reject();
        rows = value.pages.map((page) => ({ kind: 'draft', page }));
        nextCursor = value.nextCursor;
      } else if (phrase) {
        const value = await api.search(
          { spaceId, libraryIds: [target.id], query: phrase, limit: 20 },
          signal,
        );
        check(ticket, 'list');
        echo(value);
        if (
          value.query !== phrase ||
          value.libraryIds.length !== 1 ||
          value.libraryIds[0] !== target.id ||
          value.complete !== true
        )
          reject();
        rows = value.hits.map(({ snippet, ...page }) => ({ kind: 'published', page, snippet }));
        nextCursor = null;
      } else {
        const value = await api.list(request, signal);
        check(ticket, 'list');
        echo(value);
        if (value.libraryId !== target.id) reject();
        rows = value.pages.map((page) => ({ kind: 'published', page }));
        nextCursor = value.nextCursor;
      }
      for (const row of rows) if (row.kind === 'published') exact(row.page.reference);
      if (
        rows.length > 20 ||
        new Set(rows.map(rowKey)).size !== rows.length ||
        (more && nextCursor !== null && nextCursor === previous.nextCursor)
      )
        reject();
      const combined = more ? [...previous.rows, ...rows] : rows;
      if (
        new Set(
          combined.map((row) =>
            row.kind === 'published' ? row.page.reference.pageId : row.page.pageId,
          ),
        ).size !== combined.length
      )
        reject();
      putBrowse({ phase: 'ready', mode, query: phrase, rows: combined, nextCursor, error: '' });
    } catch (error) {
      if (!current(ticket, 'list')) return;
      fence(error);
      putBrowse({
        phase: 'error',
        mode,
        query: phrase,
        rows: [],
        nextCursor: null,
        error: message(error),
      });
    }
  }
  async function openLibrary() {
    const ticket = start('list');
    putBrowse(emptyBrowse());
    try {
      const value = await api.libraries({ spaceId }, ticket.controller.signal);
      check(ticket, 'list');
      echo(value);
      if (
        value.libraries.length > 1 ||
        value.libraries.some((item) => item.spaceId !== spaceId || item.id !== spaceId)
      )
        reject();
      const target = value.libraries[0];
      libraryRef.current = target;
      setLibrary(target);
      if (target) await loadRows('published');
      else putBrowse({ ...emptyBrowse(), phase: 'ready' });
    } catch (error) {
      if (!current(ticket, 'list')) return;
      fence(error);
      putBrowse({ ...emptyBrowse(), phase: 'error', error: message(error) });
    }
  }
  useEffect(() => {
    alive.current = true;
    void openLibrary();
    return () => {
      alive.current = false;
      listTicket.current?.controller.abort();
      detailTicket.current?.controller.abort();
    };
  }, []);

  async function chunk(
    reference: KnowledgeVersionRef,
    part: 'body' | 'original',
    offset: number,
    ticket: Ticket,
  ) {
    check(ticket);
    exact(reference);
    const value = await api.read(
      { ...reference, part, offset, length: KNOWLEDGE_LIMITS.readBytes },
      ticket.controller.signal,
    );
    check(ticket);
    echo(value);
    const length = encoder.encode(value.text).byteLength;
    if (
      refKey(value.reference) !== refKey(reference) ||
      value.part !== part ||
      value.offset !== offset ||
      value.length !== length ||
      length > KNOWLEDGE_LIMITS.readBytes ||
      value.nextOffset !== offset + length ||
      value.nextOffset > value.totalBytes ||
      value.totalBytes > KNOWLEDGE_LIMITS.bodyBytes ||
      (length === 0 && offset < value.totalBytes) ||
      (part === 'body' && value.partChecksum !== reference.checksum)
    )
      reject();
    value.sources.forEach(exact);
    return value;
  }
  async function whole(reference: KnowledgeVersionRef, part: 'body' | 'original', ticket: Ticket) {
    let first: KnowledgeReadValue | undefined,
      text = '',
      offset = 0;
    for (
      let count = 0;
      count < Math.ceil(KNOWLEDGE_LIMITS.bodyBytes / KNOWLEDGE_LIMITS.readBytes) + 2;
      count++
    ) {
      const value = await chunk(reference, part, offset, ticket);
      if (
        first &&
        (first.totalBytes !== value.totalBytes ||
          first.partChecksum !== value.partChecksum ||
          first.title !== value.title ||
          first.format !== value.format ||
          JSON.stringify(first.sources) !== JSON.stringify(value.sources))
      )
        reject();
      first ??= value;
      text += value.text;
      offset = value.nextOffset;
      if (offset === value.totalBytes) {
        if ((await checksum(text)) !== value.partChecksum) reject();
        check(ticket);
        return { title: first.title, format: first.format, text, sources: first.sources };
      }
    }
    return reject();
  }
  async function read(
    reference: KnowledgeVersionRef,
    title: string,
    ownerActorId?: string,
    more = false,
  ) {
    const previous = viewRef.current;
    if (busyRef.current || (more && (previous.kind !== 'reader' || previous.phase !== 'ready')))
      return;
    const before = more && previous.kind === 'reader' ? previous : undefined;
    const ticket = start('detail');
    const state: Reader = {
      kind: 'reader',
      phase: 'loading',
      reference,
      title,
      ...(ownerActorId ? { ownerActorId } : {}),
      text: before?.text ?? '',
      nextOffset: before?.nextOffset ?? 0,
      totalBytes: before?.totalBytes ?? 0,
      sources: before?.sources ?? [],
      error: '',
    };
    putView(state);
    try {
      const value = await chunk(reference, 'body', state.nextOffset, ticket);
      if (
        before &&
        (before.totalBytes !== value.totalBytes ||
          before.title !== value.title ||
          JSON.stringify(before.sources) !== JSON.stringify(value.sources))
      )
        reject();
      const text = state.text + value.text;
      if (value.nextOffset === value.totalBytes && (await checksum(text)) !== reference.checksum)
        reject();
      check(ticket);
      putView({
        ...state,
        phase: 'ready',
        title: value.title,
        text,
        nextOffset: value.nextOffset,
        totalBytes: value.totalBytes,
        sources: value.sources,
      });
    } catch (error) {
      if (!current(ticket, 'detail')) return;
      if (fence(error)) {
        setNotice(message(error));
        return;
      }
      putView({ ...state, phase: 'error', text: '', error: message(error) });
    }
  }
  async function edit(pageId: string) {
    if (busyRef.current) return;
    const ticket = start('detail');
    putBusy(true);
    setNotice('正在读取草稿…');
    try {
      const target = libraryRef.current;
      if (!target) reject();
      const value = await api.draft(
        { spaceId, libraryId: target.id, pageId },
        ticket.controller.signal,
      );
      check(ticket);
      echo(value);
      if (
        value.libraryId !== target.id ||
        value.pageId !== pageId ||
        value.ownerActorId !== actorId
      )
        reject();
      if (value.publishedHasOriginal && !value.published) reject();
      if (value.published) exact(value.published);
      let content: KnowledgeDraftContent;
      if (value.draft) {
        const { authorship: _authorship, ...body } = value.draft;
        content = KnowledgeDraftContentSchema.parse(body);
      } else if (value.published) {
        const body = await whole(value.published, 'body', ticket);
        const original = value.publishedHasOriginal
          ? await whole(value.published, 'original', ticket)
          : undefined;
        content = { ...body, ...(original ? { originalText: original.text } : {}) };
      } else reject();
      check(ticket);
      putView({
        kind: 'editor',
        pageId,
        revision: value.pageRevision,
        content,
        savedKey: contentKey(content),
        published: value.published,
        authorship: value.draft?.authorship ?? 'member',
        hasDraft: value.draft !== null,
        error: '',
      });
      setNotice('');
    } catch (error) {
      if (!current(ticket, 'detail')) return;
      fence(error);
      setNotice(message(error));
    } finally {
      if (current(ticket, 'detail')) putBusy(false);
    }
  }
  function create() {
    choose(() => {
      detailTicket.current?.controller.abort();
      setNotice('');
      const content: KnowledgeDraftContent = {
        title: '',
        format: 'markdown',
        text: '',
        sources: [],
      };
      putView({
        kind: 'editor',
        pageId: crypto.randomUUID(),
        revision: 0,
        content,
        savedKey: contentKey(content),
        published: null,
        authorship: 'member',
        hasDraft: false,
        error: '',
      });
    });
  }
  function change(patch: Partial<KnowledgeDraftContent>) {
    const before = viewRef.current;
    if (before.kind !== 'editor' || busyRef.current) return;
    inputEpoch.current++;
    putView({ ...before, content: { ...before.content, ...patch }, error: '' });
  }
  async function importFile(file: File) {
    const before = viewRef.current,
      epoch = inputEpoch.current;
    if (before.kind !== 'editor' || busyRef.current) return;
    const ticket = start('detail');
    try {
      if (file.size > KNOWLEDGE_LIMITS.bodyBytes || !/\.(?:txt|md|markdown)$/iu.test(file.name))
        throw new KnowledgeClientError('invalid');
      const bytes = await file.arrayBuffer();
      check(ticket);
      if (bytes.byteLength > KNOWLEDGE_LIMITS.bodyBytes) throw new KnowledgeClientError('limit');
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      if (epoch !== inputEpoch.current || viewRef.current !== before)
        throw new KnowledgeClientError('conflict');
      const content = KnowledgeDraftContentSchema.parse({
        ...before.content,
        title:
          before.content.title ||
          file.name
            .split(/[\\/]/u)
            .at(-1)
            ?.replace(/\.(?:txt|md|markdown)$/iu, ''),
        format: /\.txt$/iu.test(file.name) ? 'text' : 'markdown',
        text,
        originalText: text,
      });
      choose(() => {
        inputEpoch.current++;
        putView({ ...before, content, error: '' });
      });
    } catch (error) {
      if (current(ticket, 'detail')) setNotice(message(error));
    }
  }
  async function write(operation: 'save-draft' | 'publish') {
    const before = viewRef.current,
      target = libraryRef.current;
    if (before.kind !== 'editor' || !target || busyRef.current) return;
    const parsed = KnowledgeDraftContentSchema.safeParse(before.content);
    if (!parsed.success) {
      putView({ ...before, error: '请填写标题，并将正文和原文分别控制在 64 KiB 内。' });
      return;
    }
    if (
      operation === 'publish' &&
      (contentKey(before.content) !== before.savedKey ||
        !before.hasDraft ||
        parsed.data.text.length === 0)
    )
      return;
    const ticket = start('detail');
    putBusy(true);
    setNotice('');
    try {
      const signature = await checksum(
        JSON.stringify([operation, before.pageId, before.revision, contentKey(parsed.data)]),
      );
      check(ticket);
      let key = attempts.current.get(signature);
      if (!key) {
        key = crypto.randomUUID();
        attempts.current.set(signature, key);
        if (attempts.current.size > 64)
          attempts.current.delete(attempts.current.keys().next().value!);
      }
      const request = {
        spaceId,
        libraryId: target.id,
        pageId: before.pageId,
        expectedVersion: before.revision,
        idempotencyKey: key,
      };
      const value =
        operation === 'publish'
          ? await api.publish(request, ticket.controller.signal)
          : await api.saveDraft({ ...request, content: parsed.data }, ticket.controller.signal);
      check(ticket);
      echo(value);
      if (
        viewRef.current !== before ||
        value.libraryId !== target.id ||
        value.pageId !== before.pageId ||
        value.operation !== operation ||
        value.pageRevision !== before.revision + 1
      )
        reject();
      if (value.disposition === 'replayed') {
        const fresh = await api.draft(
          { spaceId, libraryId: target.id, pageId: before.pageId },
          ticket.controller.signal,
        );
        check(ticket);
        echo(fresh);
        if (
          fresh.pageId !== before.pageId ||
          fresh.libraryId !== target.id ||
          fresh.ownerActorId !== actorId ||
          fresh.pageRevision !== value.pageRevision ||
          (operation === 'save-draft' && fresh.draft === null) ||
          (operation === 'publish' &&
            (!fresh.published ||
              !value.reference ||
              refKey(fresh.published) !== refKey(value.reference)))
        )
          throw new KnowledgeClientError('conflict');
        if (operation === 'save-draft' && fresh.draft) {
          const { authorship: _authorship, ...body } = fresh.draft;
          if (contentKey(KnowledgeDraftContentSchema.parse(body)) !== contentKey(parsed.data))
            throw new KnowledgeClientError('conflict');
        }
      }
      if (operation === 'save-draft') {
        if (value.reference || !['saved', 'replayed'].includes(value.disposition)) reject();
        putView({
          ...before,
          revision: value.pageRevision,
          content: parsed.data,
          savedKey: contentKey(parsed.data),
          authorship: 'member',
          hasDraft: true,
          error: '',
        });
        setNotice('草稿已保存，尚未发布。');
        void loadRows('drafts');
      } else {
        const ref = value.reference;
        if (!ref || !['published', 'replayed'].includes(value.disposition)) reject();
        exact(ref);
        if (
          ref.pageId !== before.pageId ||
          ref.version !== (before.published?.version ?? 0) + 1 ||
          ref.checksum !== (await checksum(parsed.data.text))
        )
          reject();
        check(ticket);
        putBusy(false);
        setQuery('');
        setNotice(`已发布 v${ref.version}。`);
        void loadRows('published');
        void read(ref, parsed.data.title, actorId);
      }
    } catch (error) {
      if (!current(ticket, 'detail')) return;
      if (fence(error)) {
        setNotice(message(error));
        return;
      }
      const now = viewRef.current;
      if (now.kind === 'editor')
        putView({
          ...now,
          error:
            error instanceof KnowledgeClientError && error.code === 'conflict'
              ? '资料已变化，当前输入已保留。可继续编辑，或确认后重新读取草稿。'
              : error instanceof KnowledgeClientError && ['invalid', 'limit'].includes(error.code)
                ? '资料格式或容量超出当前限制，输入已保留。'
                : '本次保存或发布结果未确认，当前输入已保留；未改内容时可重试同一次操作。',
        });
    } finally {
      if (current(ticket, 'detail')) putBusy(false);
    }
  }

  const selected =
    view.kind === 'reader'
      ? view.reference.pageId
      : view.kind === 'editor'
        ? view.pageId
        : undefined;
  return (
    <section
      className="zhuma zm-knowledge"
      aria-labelledby={heading}
      style={{ padding: 24, minWidth: 0 }}
    >
      <header
        style={{
          display: 'flex',
          gap: 16,
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 24,
        }}
      >
        <div>
          <h1 id={heading} style={{ margin: 0, fontSize: 22, fontWeight: 650 }}>
            知识资料
          </h1>
          <p className="zm-muted" style={{ margin: '6px 0 0' }}>
            {library
              ? `${library.kind === 'personal' ? '个人' : '团队'} · ${library.name}`
              : '当前空间'}
          </p>
        </div>
        {library && (
          <Button
            variant={view.kind === 'editor' ? 'quiet' : 'primary'}
            disabled={busy}
            onClick={create}
          >
            新建资料
          </Button>
        )}
      </header>
      {notice && (
        <p role="status" className="zm-muted">
          {notice}
        </p>
      )}
      <div className="zm-expert-layout zm-knowledge-layout">
        <aside aria-label="资料目录" style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
            <Button
              variant="quiet"
              aria-pressed={browse.mode === 'published'}
              disabled={!library || busy}
              onClick={() => {
                setQuery('');
                void loadRows('published');
              }}
            >
              已发布
            </Button>
            <Button
              variant="quiet"
              aria-pressed={browse.mode === 'drafts'}
              disabled={!library || busy}
              onClick={() => {
                setQuery('');
                void loadRows('drafts');
              }}
            >
              我的草稿
            </Button>
          </div>
          {browse.mode === 'published' && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void loadRows('published', query.trim());
              }}
              style={{ display: 'flex', gap: 8, marginBottom: 16 }}
            >
              <input
                type="search"
                aria-label="搜索已发布资料"
                placeholder="搜索标题或正文…"
                value={query}
                disabled={!library || busy}
                style={{ minWidth: 0, flex: 1 }}
                onChange={(event) => setQuery(event.target.value)}
              />
              <Button
                type="submit"
                variant="quiet"
                disabled={!library || busy}
                busy={browse.phase === 'loading'}
                busyLabel=""
              >
                搜索
              </Button>
            </form>
          )}
          {browse.phase === 'loading' && (
            <p role="status" className="zm-muted">
              正在读取资料目录…
            </p>
          )}
          {browse.error && (
            <div role="alert">
              <p>{browse.error}</p>
              <Button
                onClick={() =>
                  library ? void loadRows(browse.mode, browse.query) : void openLibrary()
                }
              >
                重试
              </Button>
            </div>
          )}
          {browse.phase === 'ready' && !browse.rows.length && (
            <p className="zm-muted">
              {!library
                ? '当前空间没有可用知识库。'
                : browse.mode === 'drafts'
                  ? '还没有保存的草稿。'
                  : browse.query
                    ? '未找到匹配的已发布资料。'
                    : '还没有已发布资料，可先新建一份。'}
            </p>
          )}
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {browse.rows.map((row) => {
              const id = row.kind === 'published' ? row.page.reference.pageId : row.page.pageId;
              return (
                <li key={rowKey(row)} style={{ marginBottom: 4 }}>
                  <Button
                    variant="quiet"
                    disabled={busy}
                    aria-current={selected === id ? 'page' : undefined}
                    style={{
                      width: '100%',
                      height: 'auto',
                      textAlign: 'left',
                      display: 'grid',
                      justifyItems: 'stretch',
                      whiteSpace: 'normal',
                      padding: 12,
                      ...(selected === id ? { background: 'var(--zm-soft)' } : {}),
                    }}
                    onClick={() =>
                      choose(() =>
                        row.kind === 'published'
                          ? void read(row.page.reference, row.page.title, row.page.ownerActorId)
                          : void edit(row.page.pageId),
                      )
                    }
                  >
                    <span style={{ display: 'block', minWidth: 0, width: '100%' }}>
                      <strong style={{ display: 'block', overflowWrap: 'anywhere' }}>
                        {row.page.title}
                      </strong>
                      <span
                        className="zm-muted"
                        style={{ display: 'block', fontSize: 12, marginTop: 5 }}
                      >
                        {row.kind === 'published'
                          ? `已发布 · v${row.page.reference.version}`
                          : `${row.page.authorship === 'agent' ? 'Agent 草稿' : '草稿'} · ${row.page.savedAt ? new Date(row.page.savedAt).toLocaleString() : '保存时间未知'}`}
                      </span>
                      {row.kind === 'published' && row.snippet && (
                        <span
                          className="zm-muted"
                          style={{
                            display: 'block',
                            fontWeight: 400,
                            fontSize: 13,
                            lineHeight: 1.5,
                            maxHeight: '3em',
                            overflow: 'hidden',
                            marginTop: 8,
                          }}
                        >
                          {row.snippet}
                        </span>
                      )}
                    </span>
                  </Button>
                </li>
              );
            })}
          </ul>
          {browse.nextCursor && (
            <Button
              variant="quiet"
              disabled={browse.phase === 'loading'}
              onClick={() => void loadRows(browse.mode, browse.query, true)}
            >
              更多资料
            </Button>
          )}
        </aside>
        <article aria-label="资料正文" style={{ minWidth: 0 }}>
          {view.kind === 'empty' && (
            <div className="zm-empty">
              <h3>选择一份资料</h3>
              <p>按需查看已发布内容，或打开自己的草稿继续编辑。</p>
            </div>
          )}
          {view.kind === 'reader' && (
            <>
              <header
                style={{
                  display: 'flex',
                  gap: 16,
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <div>
                  <h2 style={{ margin: 0, fontSize: 20 }}>{view.title}</h2>
                  <p className="zm-muted">已发布 · v{view.reference.version}</p>
                </div>
                {view.ownerActorId === actorId && (
                  <Button
                    disabled={busy}
                    onClick={() => choose(() => void edit(view.reference.pageId))}
                  >
                    编辑我的草稿
                  </Button>
                )}
              </header>
              {view.phase === 'loading' && (
                <p role="status" className="zm-muted">
                  正在读取固定版本…
                </p>
              )}
              {view.error && (
                <div role="alert">
                  <p>{view.error}</p>
                  <Button onClick={() => void read(view.reference, view.title, view.ownerActorId)}>
                    重新读取
                  </Button>
                </div>
              )}
              {view.text && (
                <pre
                  style={{
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'anywhere',
                    fontFamily: 'inherit',
                    lineHeight: 1.75,
                    maxWidth: '82ch',
                    margin: '16px 0 24px',
                  }}
                >
                  {view.text}
                </pre>
              )}
              {view.phase === 'ready' && view.nextOffset < view.totalBytes && (
                <Button
                  onClick={() => void read(view.reference, view.title, view.ownerActorId, true)}
                >
                  继续读取
                </Button>
              )}
              {view.phase === 'ready' && view.sources.length > 0 && (
                <details>
                  <summary>来源资料 · {view.sources.length}</summary>
                  <ul>
                    {view.sources.map((source, index) => (
                      <li key={refKey(source)}>
                        <Button
                          variant="quiet"
                          onClick={() => choose(() => void read(source, `来源资料 ${index + 1}`))}
                        >
                          来源资料 {index + 1} · v{source.version}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
          {view.kind === 'editor' && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void write('save-draft');
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  marginBottom: 20,
                }}
              >
                <h2 style={{ margin: 0, fontSize: 20 }}>
                  {view.revision === 0 ? '新建资料' : '编辑草稿'}
                </h2>
                <span className="zm-muted">
                  {dirty
                    ? '尚未保存'
                    : !view.hasDraft
                      ? '尚未保存草稿'
                      : view.authorship === 'agent'
                        ? 'Agent 提议，待你确认'
                        : '草稿已保存'}
                </span>
              </div>
              <fieldset disabled={busy} style={{ margin: 0, padding: 0, border: 0, minWidth: 0 }}>
                <div className="zm-field">
                  <label htmlFor={titleId}>资料标题</label>
                  <input
                    id={titleId}
                    maxLength={200}
                    value={view.content.title}
                    onChange={(event) => change({ title: event.target.value })}
                  />
                </div>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16 }}>
                  <SingleSelect
                    label="正文格式"
                    disabled={busy}
                    value={view.content.format}
                    options={[
                      { value: 'markdown', label: 'Markdown' },
                      { value: 'text', label: '纯文本' },
                    ]}
                    onValueChange={(format) => {
                      if (format === 'text' || format === 'markdown') change({ format });
                    }}
                  />
                  <Button variant="quiet" onClick={() => fileInput.current?.click()}>
                    导入文本
                  </Button>
                  <input
                    ref={fileInput}
                    type="file"
                    accept=".txt,.md,.markdown,text/plain,text/markdown"
                    aria-label="导入文本文件"
                    hidden
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (file) void importFile(file);
                    }}
                  />
                </div>
                <div className="zm-field">
                  <label htmlFor={bodyId}>正文</label>
                  <textarea
                    id={bodyId}
                    rows={18}
                    style={{ resize: 'vertical', lineHeight: 1.7, minHeight: 280 }}
                    value={view.content.text}
                    onChange={(event) => change({ text: event.target.value })}
                  />
                </div>
                {view.content.originalText !== undefined && (
                  <details style={{ marginBottom: 16 }}>
                    <summary>已保留导入原文</summary>
                    <pre
                      style={{
                        whiteSpace: 'pre-wrap',
                        overflowWrap: 'anywhere',
                        fontFamily: 'inherit',
                      }}
                    >
                      {view.content.originalText}
                    </pre>
                  </details>
                )}
              </fieldset>
              {view.error && <p role="alert">{view.error}</p>}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <Button
                  type="submit"
                  variant={dirty || !view.hasDraft ? 'primary' : 'secondary'}
                  busy={busy}
                  busyLabel="处理中…"
                  disabled={!dirty && view.hasDraft}
                >
                  保存草稿
                </Button>
                <Button
                  variant={!dirty && view.hasDraft ? 'primary' : 'secondary'}
                  disabled={busy || dirty || !view.hasDraft || view.content.text.length === 0}
                  onClick={() => void write('publish')}
                >
                  发布
                </Button>
                {view.revision > 0 && (
                  <Button
                    variant="quiet"
                    disabled={busy}
                    onClick={() => choose(() => void edit(view.pageId))}
                  >
                    重新读取草稿
                  </Button>
                )}
              </div>
            </form>
          )}
        </article>
      </div>
      {confirmation && (
        <Modal
          title="放弃未保存的修改？"
          variant="confirmation"
          initialFocusId={cancelId}
          restoreFocus={confirmation.restoreFocus}
          close={() => setConfirmation(undefined)}
        >
          <div className="zm-confirmation-body">
            <p>已保存的草稿和发布版本不受影响。</p>
            <div className="zm-confirmation-actions">
              <Button id={cancelId} onClick={() => setConfirmation(undefined)}>
                继续编辑
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  const action = confirmation.action;
                  setConfirmation(undefined);
                  if (latest.current.owns() && latest.current.lifetime.isCurrent()) action();
                }}
              >
                放弃修改并继续
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
