import { useEffect, useId, useState, type ReactNode } from 'react';
import type { Participant, TeamAsset } from '@zhuma/agent-core';
import { Button } from './Button.js';
import { Field } from './controls.js';
import { SingleSelect } from './SingleSelect.js';

export type TemplateBindingValues = Record<string, string | null>;

function expertResources(person: Participant | undefined, assets: TeamAsset[]) {
  if (person?.kind !== 'expert') return [];
  return (['skill', 'mcp'] as const)
    .map((kind) => ({
      label: kind === 'skill' ? 'Skills' : 'MCP',
      items: [
        ...new Set(person.resourceBindings?.[kind === 'skill' ? 'skillIds' : 'mcpIds'] ?? []),
      ].map((id) => {
        const asset = assets.find((value) => value.id === id && value.kind === kind);
        return {
          id,
          name: asset?.name ?? `未找到的 ${kind === 'skill' ? 'Skill' : 'MCP'}`,
          available: !!asset?.available,
        };
      }),
    }))
    .filter((group) => group.label === 'Skills' || group.items.length);
}

type BindingRow = {
  id: string;
  name: string;
  selection?: string | undefined;
  issue?: string | undefined;
};

function BindingGroup({
  title,
  action,
  count,
  rows,
  showSelections = false,
  fields,
}: {
  title: string;
  action: string;
  count: string;
  rows: BindingRow[];
  showSelections?: boolean;
  fields(idFor: (id: string) => string): ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const id = useId();
  const idFor = (key: string) => `${id}-${key}`;
  const needsAttention = rows.filter((row) => row.issue).length;
  useEffect(() => {
    if (focusTarget) {
      document.getElementById(focusTarget)?.querySelector<HTMLButtonElement>('button')?.focus();
      setFocusTarget(null);
    }
  }, [focusTarget]);
  const visibleRows = open ? [] : showSelections ? rows : rows.filter((row) => row.issue);
  return (
    <section aria-labelledby={`${id}-heading`}>
      <header className="zm-template-binding-heading">
        <h4 id={`${id}-heading`}>{title}</h4>
        <span className="zm-template-binding-count" aria-live="polite">
          {count}
        </span>
        {!!needsAttention && <span className="zm-warning">需处理 {needsAttention}</span>}
        <Button
          variant="quiet"
          aria-expanded={open}
          aria-controls={`${id}-fields`}
          onClick={() => setOpen(!open)}
        >
          {open ? '收起' : '调整'}
          {action}
        </Button>
      </header>
      {!!visibleRows.length && (
        <ul className="zm-template-binding-summary" aria-label={`${title}摘要`}>
          {visibleRows.map((row) => (
            <li key={row.id}>
              {row.issue ? (
                <Button
                  variant="quiet"
                  onClick={() => {
                    setOpen(true);
                    setFocusTarget(idFor(row.id));
                  }}
                >
                  {row.name} · {row.issue}
                </Button>
              ) : (
                <span>
                  {row.name} · {row.selection}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <div id={`${id}-fields`} hidden={!open}>
        <div className="zm-template-binding-grid">{fields(idFor)}</div>
      </div>
    </section>
  );
}

export function TemplateBindings({
  roles,
  resources,
  members,
  assets,
  roleValues,
  resourceValues,
  changeRoles,
  changeResources,
}: {
  roles: { id: string; name: string; preferredKind?: 'human' | 'expert' | 'any' }[];
  resources: { id: string; name: string; kind: 'skill' | 'mcp' }[];
  members: Participant[];
  assets: TeamAsset[];
  roleValues: TemplateBindingValues;
  resourceValues: TemplateBindingValues;
  changeRoles(values: TemplateBindingValues): void;
  changeResources(values: TemplateBindingValues): void;
}) {
  const roleRows = roles.map((role) => {
    const person = members.find((member) => member.id === roleValues[role.id]);
    const groups = expertResources(person, assets);
    const missing = groups.flatMap((group) => group.items).filter((item) => !item.available).length;
    return {
      ...role,
      person,
      groups,
      selection: person?.name,
      issue: !roleValues[role.id]
        ? '待选择'
        : !person?.available
          ? '原选择不可用'
          : missing
            ? `${missing} 项专家资源不可用`
            : undefined,
    };
  });
  const resourceRows = resources.map((resource) => {
    const asset = assets.find(
      (value) => value.id === resourceValues[resource.id] && value.kind === resource.kind,
    );
    return {
      ...resource,
      asset,
      issue: !resourceValues[resource.id]
        ? '待匹配'
        : !asset?.available
          ? '原选择不可用'
          : undefined,
    };
  });
  return (
    <div className="zm-template-bindings">
      {!!roles.length && (
        <BindingGroup
          title="角色分工"
          action="分工"
          count={`已选 ${roleRows.filter((row) => row.person?.available).length}/${roles.length}`}
          rows={roleRows}
          showSelections
          fields={(idFor) =>
            roleRows.map((r) => (
              <div key={r.id} id={idFor(r.id)}>
                <Field label={r.name} hint={r.issue ?? ''}>
                  <SingleSelect
                    label={`绑定角色：${r.name}`}
                    value={roleValues[r.id] ?? ''}
                    aria-invalid={!!roleValues[r.id] && !r.person?.available}
                    onValueChange={(value) => changeRoles({ ...roleValues, [r.id]: value || null })}
                    options={[
                      { value: '', label: '稍后绑定' },
                      ...members
                        .filter((p) => p.available)
                        .sort(
                          (a, b) =>
                            Number(b.kind === r.preferredKind) - Number(a.kind === r.preferredKind),
                        )
                        .map((p) => ({
                          value: p.id,
                          label: `${p.name} · ${p.kind === 'expert' ? '专家' : p.role || '成员'}`,
                        })),
                    ]}
                  />
                </Field>
                {!!r.groups.length && (
                  <details className="zm-template-expert-resources">
                    <summary>
                      专家资源 ·{' '}
                      {r.groups.map((group) => `${group.label} ${group.items.length}`).join(' · ')}
                    </summary>
                    {r.groups.map((group) => (
                      <div key={group.label}>
                        <strong>{group.label}</strong>
                        {group.items.length ? (
                          <ul>
                            {group.items.map((item) => (
                              <li key={item.id}>
                                {item.name}
                                {!item.available && <span className="zm-warning"> · 不可用</span>}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <span> 0 项</span>
                        )}
                      </div>
                    ))}
                  </details>
                )}
              </div>
            ))
          }
        />
      )}
      {!!resources.length && (
        <BindingGroup
          title="所需能力"
          action="能力"
          count={`已匹配 ${resourceRows.filter((row) => row.asset?.available).length}/${resources.length}`}
          rows={resourceRows}
          fields={(idFor) =>
            resourceRows.map((r) => (
              <div key={r.id} id={idFor(r.id)}>
                <Field
                  label={`${r.kind === 'skill' ? 'Skill' : 'MCP'} · ${r.name}`}
                  hint={r.issue ?? ''}
                >
                  <SingleSelect
                    label={`绑定资源：${r.name}`}
                    value={resourceValues[r.id] ?? ''}
                    aria-invalid={!!resourceValues[r.id] && !r.asset?.available}
                    onValueChange={(value) =>
                      changeResources({ ...resourceValues, [r.id]: value || null })
                    }
                    options={[
                      { value: '', label: '稍后绑定' },
                      ...assets
                        .filter((a) => a.kind === r.kind && a.available)
                        .map((a) => ({ value: a.id, label: a.name })),
                    ]}
                  />
                </Field>
              </div>
            ))
          }
        />
      )}
    </div>
  );
}
