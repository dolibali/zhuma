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

export type ParticipantChoice = Participant & { placeholder?: boolean };

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
    <dialog
      className="zm-dialog"
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
      aria-labelledby={titleId}
    >
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
  roleMode = false,
}: {
  members: ParticipantChoice[];
  selected: string[];
  change(ids: string[]): void;
  disabledIds?: string[];
  selectionMode?: 'multiple' | 'single';
  roleMode?: boolean;
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
        aria-label={roleMode ? '搜索角色' : '搜索参与者'}
        placeholder={roleMode ? '搜索角色或能力' : '搜索姓名、角色或能力'}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {(['human', 'expert'] as const)
        .filter((kind) => matching.some((member) => member.kind === kind))
        .map((kind) => (
          <section key={kind}>
            <h4>
              {roleMode
                ? kind === 'human'
                  ? '通用角色'
                  : '专家角色'
                : kind === 'human'
                  ? '团队成员'
                  : 'Agent 专家'}
            </h4>
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
                      {!m.available && (m.placeholder ? ' · 待绑定' : ' · 不可用')}
                    </small>
                  </span>
                </label>
              ))}
          </section>
        ))}
      {!members.length && (
        <p className="zm-empty">
          {roleMode ? '先添加模板角色。' : '先在“成员与专家”中添加参与者。'}
        </p>
      )}
      {!!members.length && !matching.length && (
        <p className="zm-empty">{roleMode ? '没有匹配的角色。' : '没有匹配的参与者。'}</p>
      )}
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
  const [search, setSearch] = useState('');
  const matching = options.filter((option) =>
    option.name.toLowerCase().includes(search.trim().toLowerCase()),
  );
  return (
    <details className="zm-multiselect">
      <summary>
        {label}
        <span>已选 {selected.length}</span>
      </summary>
      <div className="zm-choice-panel">
        {options.length > 6 && (
          <input
            aria-label={`搜索${label}`}
            placeholder={`搜索${label}…`}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        )}
        <div className="zm-choice-options">
          {matching.map((option) => (
            <label key={option.id} title={option.name}>
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
              <span>{option.name}</span>
            </label>
          ))}
          {!options.length && <small>暂无可用选项</small>}
          {!!options.length && !matching.length && (
            <div className="zm-choice-empty">
              <small>没有匹配项</small>
              <button type="button" className="zm-quiet" onClick={() => setSearch('')}>
                清除搜索
              </button>
            </div>
          )}
        </div>
      </div>
    </details>
  );
}

export function ParticipantSelect({
  label,
  members,
  selected,
  multiple = false,
  roleMode = false,
  hint,
  change,
}: {
  label: string;
  members: ParticipantChoice[];
  selected: string[];
  multiple?: boolean;
  roleMode?: boolean;
  hint?: string;
  change(ids: string[]): void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(selected);
  const names = selected.map((id) => members.find((m) => m.id === id)?.name ?? '不可用成员');
  return (
    <div className="zm-field">
      <span className="zm-field-label">{label}</span>
      <button
        type="button"
        className="zm-person-select"
        aria-label={`选择${label}`}
        onClick={() => {
          setDraft(selected);
          setOpen(true);
        }}
      >
        <span title={names.join('、')}>
          {names.length
            ? `${names.slice(0, 3).join('、')}${names.length > 3 ? ` +${names.length - 3}` : ''}`
            : `选择${label}`}
        </span>
        <span aria-hidden>⌄</span>
      </button>
      {open && (
        <Modal title={`选择${label}`} close={() => setOpen(false)}>
          <MemberPicker
            members={members}
            selected={draft}
            selectionMode={multiple ? 'multiple' : 'single'}
            roleMode={roleMode}
            change={(ids) => setDraft(multiple ? ids : ids.slice(-1))}
          />
          <footer>
            <span className="zm-muted">
              已选 {draft.length}{' '}
              {roleMode
                ? '个角色'
                : members.some((m) => m.placeholder && draft.includes(m.id))
                  ? '项'
                  : '位'}
              {hint ? ` · ${hint}` : ''}
            </span>
            <button type="button" onClick={() => setOpen(false)}>
              取消
            </button>
            <button
              type="button"
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
            type="button"
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
            <button type="button" onClick={() => setOpen(false)}>
              取消
            </button>
            <button
              type="button"
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
