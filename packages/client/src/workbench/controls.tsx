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
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog className="zm-dialog" ref={ref} onCancel={close}>
      <header>
        <h2>{title}</h2>
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
}: {
  members: Participant[];
  selected: string[];
  change(ids: string[]): void;
  disabledIds?: string[];
}) {
  const [search, setSearch] = useState('');
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
          {members
            .filter(
              (m) =>
                m.kind === kind &&
                `${m.name} ${m.role} ${m.capabilities.join(' ')}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
            )
            .map((m) => (
              <label className="zm-member" key={m.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(m.id)}
                  disabled={
                    disabledIds.includes(m.id) || (!m.available && !selected.includes(m.id))
                  }
                  onChange={(e) =>
                    change(
                      e.target.checked ? [...selected, m.id] : selected.filter((id) => id !== m.id),
                    )
                  }
                />
                <span className={`zm-avatar ${m.kind}`}>
                  {m.kind === 'expert' ? 'AI' : m.name.slice(0, 1)}
                </span>
                <span>
                  <strong>{m.name}</strong>
                  <small>
                    {m.role || m.capabilities.join(' · ') || '尚未填写职责'}
                    {!m.available && ' · 不可用'}
                  </small>
                </span>
              </label>
            ))}
        </section>
      ))}
      {!members.length && <p className="zm-empty">先在“成员与专家”中添加参与者。</p>}
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
