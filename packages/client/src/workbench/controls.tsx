import {
  cloneElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { Participant } from '@zhuma/agent-core';

export function Modal({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close(): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog className="zm-dialog" ref={ref} onCancel={close} aria-labelledby={titleId}>
      <header>
        <h2 id={titleId}>{title}</h2>
        <button type="button" aria-label="关闭" onClick={close}>
          ×
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function MemberPicker({
  members,
  selected,
  change,
  disabledIds = [],
  selectionMode = 'multiple',
}: {
  members: Participant[];
  selected: string[];
  change(ids: string[]): void;
  disabledIds?: string[];
  selectionMode?: 'multiple' | 'single';
}) {
  const [search, setSearch] = useState('');
  const groupId = useId();
  const matching = members.filter((member) =>
    `${member.name} ${member.role} ${member.capabilities.join(' ')}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <div className="zm-picker">
      <input
        aria-label="搜索参与者"
        placeholder="搜索姓名、角色或能力"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {(['human', 'expert'] as const).map((kind) => (
        <section key={kind}>
          <h4>{kind === 'human' ? '团队成员' : 'Agent 专家'}</h4>
          {matching
            .filter((m) => m.kind === kind)
            .map((m) => (
              <label className="zm-member" key={m.id}>
                <input
                  type={selectionMode === 'single' ? 'radio' : 'checkbox'}
                  name={selectionMode === 'single' ? groupId : undefined}
                  checked={selected.includes(m.id)}
                  disabled={
                    disabledIds.includes(m.id) || (!m.available && !selected.includes(m.id))
                  }
                  onChange={(e) =>
                    change(
                      selectionMode === 'single'
                        ? [m.id]
                        : e.target.checked
                          ? [...selected, m.id]
                          : selected.filter((id) => id !== m.id),
                    )
                  }
                />
                <span className={`zm-avatar ${m.kind}`}>
                  {m.kind === 'expert' ? 'AI' : m.name.slice(0, 1)}
                </span>
                <span>
                  <strong>{m.name}</strong>
                  <small title={m.role || m.capabilities.join(' · ')}>
                    {m.role || m.capabilities.join(' · ') || '尚未填写职责'}
                    {!m.available && ' · 不可用'}
                  </small>
                </span>
              </label>
            ))}
        </section>
      ))}
      {!members.length && <p className="zm-empty">先在“成员与专家”中添加参与者。</p>}
      {!!members.length && !matching.length && <p className="zm-empty">没有匹配的参与者。</p>}
    </div>
  );
}
export function MultiSelect({
  label,
  options,
  selected,
  change,
}: {
  label: string;
  options: { id: string; name: string }[];
  selected: string[];
  change(ids: string[]): void;
}) {
  return (
    <details className="zm-multiselect">
      <summary>
        {label}
        <span>已选 {selected.length}</span>
      </summary>
      <div>
        {options.map((option) => (
          <label key={option.id}>
            <input
              type="checkbox"
              checked={selected.includes(option.id)}
              onChange={(e) =>
                change(
                  e.target.checked
                    ? [...selected, option.id]
                    : selected.filter((id) => id !== option.id),
                )
              }
            />
            {option.name}
          </label>
        ))}
        {!options.length && <small>暂无可用选项</small>}
      </div>
    </details>
  );
}

export function ParticipantSelect({
  label,
  members,
  selected,
  multiple = false,
  change,
}: {
  label: string;
  members: Participant[];
  selected: string[];
  multiple?: boolean;
  change(ids: string[]): void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(selected);
  const names = selected.map((id) => members.find((m) => m.id === id)?.name ?? '不可用成员');
  return (
    <div className="zm-field">
      <span className="zm-field-label">{label}</span>
      <button
        className="zm-person-select"
        aria-label={`选择${label}`}
        onClick={() => {
          setDraft(selected);
          setOpen(true);
        }}
      >
        <span>{names.length ? names.join('、') : `选择${label}`}</span>
        <span aria-hidden>⌄</span>
      </button>
      {open && (
        <Modal title={`选择${label}`} close={() => setOpen(false)}>
          <MemberPicker
            members={members}
            selected={draft}
            selectionMode={multiple ? 'multiple' : 'single'}
            change={(ids) => setDraft(multiple ? ids : ids.slice(-1))}
          />
          <footer>
            <span className="zm-muted">
              已选 {draft.length} 位{multiple ? ' · 全部通过后交接' : ''}
            </span>
            <button onClick={() => setOpen(false)}>取消</button>
            <button
              className="primary"
              onClick={() => {
                change(draft);
                setOpen(false);
              }}
            >
              确认选择
            </button>
          </footer>
        </Modal>
      )}
    </div>
  );
}

export function ExpandableText({
  label,
  value,
  change,
}: {
  label: string;
  value: string;
  change(value: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  return (
    <>
      {value.length > 90 ? (
        <div className="zm-field">
          <span className="zm-field-label">{label}</span>
          <button
            className="zm-text-preview"
            aria-label={`编辑${label}`}
            onClick={() => {
              setDraft(value);
              setOpen(true);
            }}
          >
            <span>{value.slice(0, 90)}…</span>
            <small>展开编辑 ↗</small>
          </button>
        </div>
      ) : (
        <Field label={label}>
          <textarea rows={3} value={value} onChange={(e) => change(e.target.value)} />
        </Field>
      )}
      {open && (
        <Modal title={`编辑${label}`} close={() => setOpen(false)}>
          <div className="zm-form-body">
            <Field label={label}>
              <textarea
                autoFocus
                rows={12}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
            </Field>
          </div>
          <footer>
            <button onClick={() => setOpen(false)}>取消</button>
            <button
              className="primary"
              onClick={() => {
                change(draft);
                setOpen(false);
              }}
            >
              保存内容
            </button>
          </footer>
        </Modal>
      )}
    </>
  );
}
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactElement<{ id?: string }>;
}) {
  const id = useId();
  return (
    <div className="zm-field">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id })}
    </div>
  );
}
