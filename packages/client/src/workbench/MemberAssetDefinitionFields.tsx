import { useEffect, useMemo, useState } from 'react';
import {
  canonicalPayload,
  parseWorkflowTemplate,
  type MemberAssetDefinition,
  type MemberAssetReadValue,
  type MemberAssetReference,
  type Workbench,
} from '@zhuma/agent-core';
import { Field } from './controls.js';
import { Button } from './Button.js';
import { SingleSelect } from './SingleSelect.js';
import { TemplateDefinitionEditor } from './TemplateDefinitionEditor.js';

type Dependency = MemberAssetReadValue['dependencies'][number];
export interface MemberAssetDefinitionFieldsProps {
  value: MemberAssetDefinition;
  dependencies: readonly Dependency[];
  choices: readonly { reference: MemberAssetReference; name: string; version: number }[];
  requirements?: readonly { slotId: string; kind: 'skill' | 'mcp' }[];
  authoringState?: Workbench;
  readOnlyDefinition?: boolean;
  disabled?: boolean;
  onChange(value: MemberAssetDefinition, dependencies: Dependency[]): void;
}
const copyDependencies = (values: readonly Dependency[]): Dependency[] =>
  values.map(({ slotId, reference }) => ({ slotId, reference: { ...reference } }));

/** Controlled definition fields only. The parent owns loading, authorization,
 * draft/version selection and every save/publish operation. */
export function MemberAssetDefinitionFields({
  value,
  dependencies,
  choices,
  requirements = [],
  authoringState,
  readOnlyDefinition = false,
  disabled = false,
  onChange,
}: MemberAssetDefinitionFieldsProps) {
  const [opened, setOpened] = useState<{
    definition: MemberAssetDefinition;
    state: Workbench;
  } | null>(null);
  const editor =
    opened?.definition === value &&
    value.kind === 'template' &&
    authoringState &&
    !disabled &&
    !readOnlyDefinition
      ? opened
      : null;
  useEffect(() => {
    if (opened && !editor) setOpened(null);
  }, [opened, editor]);
  const templateContent = value.kind === 'template' ? value.content : null;
  const templateInvalid = useMemo(() => {
    if (templateContent === null || !templateContent.trim()) return false;
    try {
      parseWorkflowTemplate(templateContent);
      return false;
    } catch {
      return true;
    }
  }, [templateContent]);
  const change = (definition: MemberAssetDefinition, next = dependencies) => {
    if (!disabled) onChange(definition, copyDependencies(next));
  };
  const changeDefinition = (definition: MemberAssetDefinition) => {
    if (!readOnlyDefinition) change(definition);
  };
  // Complete fixed references identify choices; neither a name nor a numeric
  // version can select another publication, source, space or latest version.
  const skillChoices = new Map(
    choices
      .filter((choice) => choice.reference.kind === 'skill')
      .map((choice) => [canonicalPayload(choice.reference), choice]),
  );
  const slots = [...new Set(requirements.map((requirement) => requirement.slotId))];
  const captions = new Map<string, number>();
  for (const choice of skillChoices.values()) {
    const label = `${choice.name} · 第 ${choice.version} 版`;
    captions.set(label, (captions.get(label) ?? 0) + 1);
  }
  const caption = (reference: MemberAssetReference) => {
    const choice = skillChoices.get(canonicalPayload(reference));
    if (!choice) return `${reference.assetId} · 固定版本 ${reference.versionId}`;
    const label = `${choice.name} · 第 ${choice.version} 版`;
    return captions.get(label)! > 1
      ? `${label} · ${reference.spaceId}/${reference.assetId}`
      : label;
  };
  return (
    <div className="zm-member-asset-definition-fields">
      <Field label="名称">
        <input
          maxLength={160}
          value={value.name}
          disabled={disabled}
          readOnly={readOnlyDefinition}
          onChange={(event) => changeDefinition({ ...value, name: event.currentTarget.value })}
        />
      </Field>
      <Field label="描述">
        <textarea
          rows={3}
          maxLength={8000}
          value={value.description}
          disabled={disabled}
          readOnly={readOnlyDefinition}
          onChange={(event) =>
            changeDefinition({ ...value, description: event.currentTarget.value })
          }
        />
      </Field>
      {value.kind === 'expert' && (
        <>
          <Field label="角色定位">
            <input
              maxLength={300}
              value={value.role}
              disabled={disabled}
              readOnly={readOnlyDefinition}
              onChange={(event) => changeDefinition({ ...value, role: event.currentTarget.value })}
            />
          </Field>
          <Field label="能力关键词（逗号或换行分隔）">
            <textarea
              rows={3}
              value={value.capabilities.join('\n')}
              disabled={disabled}
              readOnly={readOnlyDefinition}
              onChange={(event) =>
                changeDefinition({
                  ...value,
                  capabilities: event.currentTarget.value
                    ? event.currentTarget.value.split(/\r?\n|[,，]/u)
                    : [],
                })
              }
              onBlur={() => {
                const capabilities = value.capabilities.map((item) => item.trim()).filter(Boolean);
                if (
                  capabilities.length !== value.capabilities.length ||
                  capabilities.some((item, index) => item !== value.capabilities[index])
                )
                  changeDefinition({ ...value, capabilities });
              }}
            />
          </Field>
          <Field label="专家指令">
            <textarea
              rows={8}
              maxLength={32000}
              value={value.instructions}
              disabled={disabled}
              readOnly={readOnlyDefinition}
              onChange={(event) =>
                changeDefinition({ ...value, instructions: event.currentTarget.value })
              }
            />
          </Field>
        </>
      )}
      {value.kind === 'skill' && (
        <Field label="Skill 内容">
          <textarea
            rows={10}
            maxLength={60000}
            value={value.content}
            disabled={disabled}
            readOnly={readOnlyDefinition}
            onChange={(event) => changeDefinition({ ...value, content: event.currentTarget.value })}
          />
        </Field>
      )}
      {value.kind === 'template' && (
        <>
          <Field label="工作流完整内容">
            <textarea
              rows={10}
              maxLength={150000}
              value={value.content}
              disabled={disabled}
              readOnly={readOnlyDefinition}
              onChange={(event) =>
                changeDefinition({ ...value, content: event.currentTarget.value })
              }
            />
          </Field>
          {templateInvalid && (
            <p className="zm-muted" role="status">
              工作流内容暂不能解析，请先修复原文。原内容已完整保留。
            </p>
          )}
          {authoringState && (
            <Button
              variant="quiet"
              disabled={disabled || readOnlyDefinition || templateInvalid}
              onClick={() => {
                if (!disabled && !readOnlyDefinition && !templateInvalid)
                  setOpened({ definition: value, state: authoringState });
              }}
            >
              编辑工作流结构
            </Button>
          )}
          {editor && (
            <TemplateDefinitionEditor
              content={value.content}
              state={editor.state}
              close={() => setOpened(null)}
              apply={(content) => {
                changeDefinition({ ...value, content });
                setOpened(null);
              }}
            />
          )}
        </>
      )}
      {(slots.length > 0 || dependencies.length > 0) && (
        <section aria-label="依赖资源">
          <h3>依赖资源</h3>
          {slots.map((slotId) => {
            const matching = requirements.filter((requirement) => requirement.slotId === slotId);
            const kinds = new Set(matching.map((requirement) => requirement.kind));
            const existing = dependencies.find((dependency) => dependency.slotId === slotId);
            if (kinds.size !== 1 || matching[0]?.kind === 'mcp')
              return (
                <div className="zm-field" key={slotId}>
                  <span>{slotId}</span>
                  <span className="zm-muted">
                    {kinds.size !== 1
                      ? '资源要求存在歧义，现有引用保持不变。'
                      : 'MCP 尚未满足：当前没有可选择的已发布 MCP 资源。'}
                  </span>
                  {existing && <span>{caption(existing.reference)}（已保留）</span>}
                </div>
              );
            const selected = existing ? canonicalPayload(existing.reference) : '';
            return (
              <div key={slotId}>
                <Field label={`Skill 依赖 · ${slotId}`}>
                  <SingleSelect
                    label={`Skill 依赖 · ${slotId}`}
                    value={selected}
                    disabled={disabled}
                    options={[
                      { value: '', label: '未选择' },
                      ...(existing && !skillChoices.has(selected)
                        ? [
                            {
                              value: selected,
                              label: `${caption(existing.reference)}（已保留）`,
                              disabled: true,
                            },
                          ]
                        : []),
                      ...[...skillChoices].map(([key, choice]) => ({
                        value: key,
                        label: caption(choice.reference),
                      })),
                    ]}
                    onValueChange={(key) => {
                      const choice = skillChoices.get(key);
                      if (key && !choice) return;
                      change(value, [
                        ...dependencies.filter((dependency) => dependency.slotId !== slotId),
                        ...(choice ? [{ slotId, reference: { ...choice.reference } }] : []),
                      ]);
                    }}
                  />
                </Field>
                {existing && !skillChoices.has(selected) && (
                  <p className="zm-muted">该固定引用不在当前可选目录，已保留。</p>
                )}
              </div>
            );
          })}
          {dependencies
            .filter((dependency) => !slots.includes(dependency.slotId))
            .map((dependency, index) => (
              <div className="zm-field" key={`${dependency.slotId}:${index}`}>
                <span>未识别依赖 · {dependency.slotId}（已保留）</span>
                <span>{caption(dependency.reference)}</span>
              </div>
            ))}
        </section>
      )}
    </div>
  );
}
