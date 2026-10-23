import type { Participant, TeamAsset } from '@zhuma/agent-core';
import { Field } from './controls.js';
import { SingleSelect } from './SingleSelect.js';

export type TemplateBindingValues = Record<string, string | null>;

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
  return (
    <div className="zm-template-bindings">
      {!!roles.length && (
        <section>
          <h4>角色分工</h4>
          <div className="zm-template-binding-grid">
            {roles.map((r) => (
              <Field key={r.id} label={r.name}>
                <SingleSelect
                  label={`绑定角色：${r.name}`}
                  value={roleValues[r.id] ?? ''}
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
            ))}
          </div>
        </section>
      )}
      {!!resources.length && (
        <section>
          <h4>所需能力</h4>
          <div className="zm-template-binding-grid">
            {resources.map((r) => (
              <Field key={r.id} label={`${r.kind === 'skill' ? 'Skill' : 'MCP'} · ${r.name}`}>
                <SingleSelect
                  label={`绑定资源：${r.name}`}
                  value={resourceValues[r.id] ?? ''}
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
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
