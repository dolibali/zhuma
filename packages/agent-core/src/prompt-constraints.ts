import { parseDocument } from 'yaml';
import { canonicalPayload } from './concurrency.js';

/** 项目或工作区约束快照。不是独立规则产品，也不读取文件系统。 */
export const PROMPT_CONSTRAINT_SCHEMA = 'zhuma-prompt-constraints@1';
const AGENTS_PATH = 'AGENTS.md';
const AGENTS_CHARS = 12000;
const SKILL_CHARS = 60000;
const MAX_SKILLS = 24;

export type ConstraintIssueCode =
  | 'constraint-invalid'
  | 'skill-frontmatter-invalid'
  | 'skill-version-conflict'
  | 'scope-exceeded'
  | 'output-format-mismatch'
  | 'forbidden-path'
  | 'tool-not-allowed';

export interface ConstraintIssue {
  readonly code: ConstraintIssueCode;
  readonly target: string;
  readonly reason: string;
}

export class PromptConstraintError extends Error {
  readonly issues: readonly ConstraintIssue[];

  constructor(
    readonly code: 'constraint-unfrozen' | 'constraint-violation',
    message: string,
    issues: readonly ConstraintIssue[] = [],
  ) {
    super(message);
    this.name = 'PromptConstraintError';
    this.issues = Object.freeze([...issues]);
  }
}

/** 调用方已经读到的 SKILL.md。id 与 version 是要钉住的资产版本，不是前言里的别名字段。 */
export interface SkillConstraintSource {
  readonly id: string;
  readonly version: string;
  readonly text: string;
}

export interface SkillVersionPin {
  readonly id: string;
  readonly version: string;
}

/**
 * 项目或工作区提供的原文。
 * `agentsMd` 省略或为 null 表示文件不存在，按软成功处理。
 */
export interface PromptConstraintLoad {
  readonly agentsMd?: string | null;
  readonly skills?: readonly SkillConstraintSource[];
  readonly skillPins?: readonly SkillVersionPin[];
}

export interface PinnedSkillConstraint {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly allowedTools: readonly string[];
  /** 前言写了 allowed-tools 时为 true。未写则不收紧工具。 */
  readonly limitsTools: boolean;
  readonly digest: string;
}

export interface PromptConstraintSnapshot {
  readonly schema: typeof PROMPT_CONSTRAINT_SCHEMA;
  readonly id: string;
  readonly agents: {
    readonly path: typeof AGENTS_PATH;
    readonly present: boolean;
    readonly digest: string | null;
  };
  readonly skills: readonly PinnedSkillConstraint[];
  readonly pins: readonly {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly discardedVersions: readonly string[];
  }[];
  readonly limits: {
    readonly scopePaths: readonly string[];
    readonly scopeNotes: readonly string[];
    readonly outputFormat: string | null;
    readonly forbiddenPaths: readonly string[];
  };
  /** 规划提示与执行提示共用的同一段约束正文。 */
  readonly text: string;
}

export type PromptConstraintLoadResult =
  | { readonly ok: true; readonly snapshot: PromptConstraintSnapshot }
  | { readonly ok: false; readonly issues: readonly ConstraintIssue[] };

export interface ConstraintSubject {
  readonly paths?: readonly string[];
  readonly texts?: readonly string[];
  readonly outputFormat?: string;
  readonly outputText?: string;
  readonly tools?: readonly string[];
}

export interface PlanningConstraintNode {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly input: string;
  readonly output: string;
  readonly rationale: string;
}

interface ParsedSkill {
  id: string;
  version: string;
  name: string;
  description: string;
  allowedTools: string[];
  limitsTools: boolean;
}

interface ParsedAgents {
  present: boolean;
  digest: string | null;
  body: string;
  scopePaths: string[];
  scopeNotes: string[];
  outputFormat: string | null;
  forbiddenPaths: string[];
}

const frozenSnapshots = new WeakSet<object>();

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) freeze(record[key]);
    Object.freeze(value);
  }
  return value;
}

function fingerprint(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b1;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ code, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

function issue(code: ConstraintIssueCode, target: string, reason: string): ConstraintIssue {
  return { code, target, reason };
}

function emptyAgents(): ParsedAgents {
  return {
    present: false,
    digest: null,
    body: '',
    scopePaths: [],
    scopeNotes: [],
    outputFormat: null,
    forbiddenPaths: [],
  };
}

function splitList(value: string): string[] {
  return value
    .split(/[,，;；]/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function asScope(value: string): { path: string } | { note: string } | undefined {
  if (!value || value.length > 200 || /[\u0000-\u001f\\]/.test(value) || value.includes('..'))
    return undefined;
  const pathLike = !/\s/u.test(value) && (value.includes('/') || value.startsWith('.'));
  if (!pathLike) return { note: value };
  if (value.startsWith('/')) return undefined;
  const path = value.replace(/^\.\//u, '').replace(/\/+$/u, '');
  if (!path || path.split('/').some((part) => !part || part === '..')) return undefined;
  return { path };
}

function asForbidden(value: string): string | undefined {
  if (!value || value.length > 200 || /[\s\u0000-\u001f\\]/.test(value)) return undefined;
  if (value.startsWith('/') || value.includes('..')) return undefined;
  const path = value.replace(/^\.\//u, '').replace(/\/+$/u, '');
  return /^[\w.@-]+(?:\/[\w.@-]+)*$/u.test(path) ? path : undefined;
}

function asFormat(value: string): string | undefined {
  return /^[\p{L}\p{N}_-]{1,32}$/u.test(value) ? value : undefined;
}

function parseAgents(text: string | null | undefined, issues: ConstraintIssue[]): ParsedAgents {
  if (text === undefined || text === null) return emptyAgents();
  if (typeof text !== 'string') {
    issues.push(issue('constraint-invalid', AGENTS_PATH, 'AGENTS.md 必须是文本。'));
    return emptyAgents();
  }
  const body = text.replace(/^\uFEFF/u, '');
  if (body.length > AGENTS_CHARS) {
    issues.push(issue('constraint-invalid', AGENTS_PATH, 'AGENTS.md 超过 12000 字符。'));
    return emptyAgents();
  }
  const parsed: ParsedAgents = { ...emptyAgents(), present: true, digest: fingerprint(body), body };
  let format: string | undefined;
  for (const line of body.split(/\r?\n/u)) {
    const match =
      /^(?:#{1,6}[ \t]*)?(生成范围|输出格式|禁止路径|scope|output-format|forbidden-path)[ \t]*[:：][ \t]*(.+)$/iu.exec(
        line.trim(),
      );
    if (!match?.[1] || !match[2]) continue;
    const label = match[1].toLowerCase();
    if (label === '生成范围' || label === 'scope') {
      for (const item of splitList(match[2])) {
        const scope = asScope(item);
        if (!scope) issues.push(issue('constraint-invalid', AGENTS_PATH, `生成范围无效：${item}`));
        else if ('path' in scope) parsed.scopePaths.push(scope.path);
        else parsed.scopeNotes.push(scope.note);
      }
    } else if (label === '输出格式' || label === 'output-format') {
      const token = asFormat(match[2].trim());
      if (!token) issues.push(issue('constraint-invalid', AGENTS_PATH, '输出格式无效。'));
      else if (format && format.toLowerCase() !== token.toLowerCase())
        issues.push(issue('constraint-invalid', AGENTS_PATH, '输出格式出现了互相冲突的声明。'));
      else format = token;
    } else {
      for (const item of splitList(match[2])) {
        const path = asForbidden(item);
        if (!path) issues.push(issue('constraint-invalid', AGENTS_PATH, `禁止路径无效：${item}`));
        else parsed.forbiddenPaths.push(path);
      }
    }
  }
  parsed.outputFormat = format ?? null;
  return parsed;
}

function parseSkill(
  source: SkillConstraintSource,
  issues: ConstraintIssue[],
): ParsedSkill | undefined {
  const target = typeof source?.id === 'string' && source.id ? source.id : 'skill';
  if (
    !source ||
    typeof source.id !== 'string' ||
    typeof source.version !== 'string' ||
    typeof source.text !== 'string'
  ) {
    issues.push(
      issue('skill-frontmatter-invalid', target, 'Skill 约束需要 id、version 和 SKILL.md 原文。'),
    );
    return undefined;
  }
  if (!/^[\w-]{1,100}$/u.test(source.id) || !/^[\w.+-]{1,80}$/u.test(source.version)) {
    issues.push(issue('skill-frontmatter-invalid', target, 'Skill 标识或版本无效。'));
    return undefined;
  }
  const text = source.text.replace(/^\uFEFF/u, '');
  if (text.length > SKILL_CHARS) {
    issues.push(issue('skill-frontmatter-invalid', target, 'SKILL.md 超过 60000 字符。'));
    return undefined;
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(text);
  if (!match?.[1] || !match[2]?.trim()) {
    issues.push(issue('skill-frontmatter-invalid', target, 'SKILL.md 需要 YAML 前言和非空正文。'));
    return undefined;
  }
  const doc = parseDocument(match[1], { schema: 'failsafe', strict: true, uniqueKeys: true });
  if (doc.errors.length || doc.warnings.length) {
    issues.push(issue('skill-frontmatter-invalid', target, 'SKILL.md 前言格式无效。'));
    return undefined;
  }
  let meta: Record<string, unknown>;
  try {
    const value: unknown = doc.toJS({ maxAliasCount: 0 });
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('meta');
    meta = value as Record<string, unknown>;
  } catch {
    issues.push(issue('skill-frontmatter-invalid', target, 'SKILL.md 前言必须是静态键值。'));
    return undefined;
  }
  const name = meta.name;
  const description = meta.description;
  if (
    typeof name !== 'string' ||
    name.toLowerCase() !== name ||
    name.length > 64 ||
    !/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(name)
  ) {
    issues.push(issue('skill-frontmatter-invalid', target, 'SKILL.md 需要符合约定的小写 name。'));
    return undefined;
  }
  if (typeof description !== 'string' || !description.trim() || description.trim().length > 1024) {
    issues.push(issue('skill-frontmatter-invalid', target, 'SKILL.md 需要非空 description。'));
    return undefined;
  }
  const allowedTools: string[] = [];
  let limitsTools = false;
  if (Object.hasOwn(meta, 'allowed-tools')) {
    const raw = meta['allowed-tools'];
    if (typeof raw !== 'string' || raw.length > 2000) {
      issues.push(
        issue(
          'skill-frontmatter-invalid',
          target,
          'allowed-tools 必须是不超过 2000 字符的字符串。',
        ),
      );
      return undefined;
    }
    limitsTools = true;
    const seen = new Set<string>();
    for (const token of raw.split(/\s+/u)) {
      if (!token || seen.has(token)) continue;
      if (token.length > 80) {
        issues.push(issue('skill-frontmatter-invalid', target, 'allowed-tools 中的工具名过长。'));
        return undefined;
      }
      seen.add(token);
      allowedTools.push(token);
    }
  }
  return {
    id: source.id,
    version: source.version,
    name,
    description: description.trim(),
    allowedTools,
    limitsTools,
  };
}

function clusters(skills: readonly ParsedSkill[]): ParsedSkill[][] {
  const pending = skills.map((skill, index) => ({ skill, index }));
  const used = new Set<number>();
  const groups: ParsedSkill[][] = [];
  for (const start of pending) {
    if (used.has(start.index)) continue;
    const group = [start.skill];
    used.add(start.index);
    let grew = true;
    while (grew) {
      grew = false;
      for (const item of pending) {
        if (used.has(item.index)) continue;
        if (
          group.some((current) => current.id === item.skill.id || current.name === item.skill.name)
        ) {
          group.push(item.skill);
          used.add(item.index);
          grew = true;
        }
      }
    }
    groups.push(group);
  }
  return groups;
}

function signature(skill: ParsedSkill): string {
  return canonicalPayload([
    skill.id,
    skill.version,
    skill.name,
    skill.description,
    skill.allowedTools,
    skill.limitsTools,
  ]);
}

function renderText(
  agents: ParsedAgents,
  skills: readonly PinnedSkillConstraint[],
  pins: PromptConstraintSnapshot['pins'],
  limits: PromptConstraintSnapshot['limits'],
): string {
  const lines = [
    '# 提示约束',
    agents.present ? `## AGENTS.md\n${agents.body.trim()}` : '## AGENTS.md\n未提供',
  ];
  if (skills.length) {
    lines.push('## Skills');
    for (const skill of skills) {
      lines.push(`- ${skill.id}@${skill.version} ${skill.name}`);
      lines.push(`  ${skill.description}`);
      if (skill.limitsTools) lines.push(`  allowed-tools: ${skill.allowedTools.join(' ')}`);
    }
  }
  if (pins.length) {
    lines.push('## 钉住的版本');
    for (const pin of pins)
      lines.push(`- ${pin.id}@${pin.version} 弃用 ${pin.discardedVersions.join('、')}`);
  }
  const limitLines = [
    ...limits.scopePaths.map((scope) => `生成范围: ${scope}`),
    ...limits.scopeNotes.map((note) => `生成范围: ${note}`),
    ...(limits.outputFormat ? [`输出格式: ${limits.outputFormat}`] : []),
    ...limits.forbiddenPaths.map((path) => `禁止路径: ${path}`),
  ];
  if (limitLines.length) lines.push('## 限制', ...limitLines);
  return lines.join('\n');
}

/** 从 AGENTS.md 与 SKILL.md 前言加载一份冻结快照。缺文件不报错。 */
export function loadPromptConstraints(
  input: PromptConstraintLoad = {},
): PromptConstraintLoadResult {
  const issues: ConstraintIssue[] = [];
  const agents = parseAgents(input.agentsMd, issues);
  const sources = input.skills ?? [];
  const pins = input.skillPins ?? [];
  if (!Array.isArray(sources) || sources.length > MAX_SKILLS)
    issues.push(issue('constraint-invalid', 'skills', 'Skill 约束最多 24 项。'));
  if (!Array.isArray(pins))
    issues.push(issue('constraint-invalid', 'skillPins', 'Skill 版本钉需要是列表。'));
  const parsed: ParsedSkill[] = [];
  if (Array.isArray(sources) && sources.length <= MAX_SKILLS) {
    for (const source of sources) {
      const skill = parseSkill(source, issues);
      if (skill) parsed.push(skill);
    }
  }
  if (Array.isArray(pins)) {
    for (const pin of pins) {
      if (
        !pin ||
        typeof pin.id !== 'string' ||
        typeof pin.version !== 'string' ||
        !/^[\w-]{1,100}$/u.test(pin.id) ||
        !/^[\w.+-]{1,80}$/u.test(pin.version)
      )
        issues.push(issue('constraint-invalid', 'skillPins', 'Skill 版本钉的标识或版本无效。'));
    }
  }
  if (issues.length) return { ok: false, issues: Object.freeze(issues) };
  const kept: ParsedSkill[] = [];
  const resolvedPins: PromptConstraintSnapshot['pins'][number][] = [];
  for (const group of clusters(parsed)) {
    const distinct: ParsedSkill[] = [];
    const seen = new Set<string>();
    for (const skill of group) {
      const key = signature(skill);
      if (seen.has(key)) continue;
      seen.add(key);
      distinct.push(skill);
    }
    distinct.sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version));
    const only = distinct[0];
    if (!only) continue;
    if (distinct.length === 1) {
      kept.push(only);
      continue;
    }
    const chosen = distinct.filter((skill) =>
      pins.some((pin) => pin.id === skill.id && pin.version === skill.version),
    );
    const selected = chosen[0];
    if (chosen.length !== 1 || !selected) {
      issues.push(
        issue(
          'skill-version-conflict',
          distinct.map((skill) => `${skill.id}@${skill.version}`).join(','),
          `Skill「${only.name}」存在多个版本，需要用 skillPins 钉住一个版本。`,
        ),
      );
      continue;
    }
    kept.push(selected);
    resolvedPins.push({
      id: selected.id,
      name: selected.name,
      version: selected.version,
      discardedVersions: [
        ...new Set(distinct.filter((skill) => skill !== selected).map((skill) => skill.version)),
      ].sort(),
    });
  }
  if (issues.length) return { ok: false, issues: Object.freeze(issues) };
  kept.sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version));
  resolvedPins.sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version));
  const skills: PinnedSkillConstraint[] = kept.map((skill) => ({
    id: skill.id,
    version: skill.version,
    name: skill.name,
    description: skill.description,
    allowedTools: skill.allowedTools,
    limitsTools: skill.limitsTools,
    digest: fingerprint(
      canonicalPayload({
        id: skill.id,
        version: skill.version,
        name: skill.name,
        description: skill.description,
        allowedTools: skill.allowedTools,
        limitsTools: skill.limitsTools,
      }),
    ),
  }));
  const limits = {
    scopePaths: [...new Set(agents.scopePaths)].sort(),
    scopeNotes: [...new Set(agents.scopeNotes)].sort(),
    outputFormat: agents.outputFormat,
    forbiddenPaths: [...new Set(agents.forbiddenPaths)].sort(),
  };
  const text = renderText(agents, skills, resolvedPins, limits);
  const id = fingerprint(
    canonicalPayload({
      schema: PROMPT_CONSTRAINT_SCHEMA,
      agents: { path: AGENTS_PATH, present: agents.present, digest: agents.digest },
      skills,
      pins: resolvedPins,
      limits,
      text,
    }),
  );
  const snapshot = freeze({
    schema: PROMPT_CONSTRAINT_SCHEMA,
    id,
    agents: { path: AGENTS_PATH, present: agents.present, digest: agents.digest },
    skills,
    pins: resolvedPins,
    limits,
    text,
  } satisfies PromptConstraintSnapshot);
  frozenSnapshots.add(snapshot);
  return { ok: true, snapshot };
}

/** 规划上下文与执行提示只能读回这次加载冻结的对象。 */
export function readPromptConstraints(
  snapshot: PromptConstraintSnapshot,
): PromptConstraintSnapshot {
  if (!snapshot || typeof snapshot !== 'object' || !frozenSnapshots.has(snapshot)) {
    throw new PromptConstraintError(
      'constraint-unfrozen',
      '规划与执行只能读取同一次加载得到的冻结约束快照。',
    );
  }
  return snapshot;
}

export function executionConstraintText(snapshot: PromptConstraintSnapshot): string {
  const frozen = readPromptConstraints(snapshot);
  return `约束快照 ${frozen.id}\n${frozen.text}`;
}

const PATH_PATTERN = /(?<![\w@])(?:\.?[\w.-]+\/)+[\w.@/-]*|(?<![\w@])\.env(?:\.[\w.-]+)?(?![\w])/gu;

function pathsIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(PATH_PATTERN)) {
    const token = match[0]?.replace(/[),.;，。）]+$/u, '');
    if (!token || token.includes('://')) continue;
    const path = normalizePath(token);
    if (path) found.push(path);
  }
  return found;
}

function normalizePath(value: string): string | undefined {
  const path = value
    .replace(/\\/g, '/')
    .replace(/^\.\/+/u, '')
    .replace(/\/+$/u, '');
  if (!path || path.split('/').some((part) => !part || part === '.' || part === '..'))
    return undefined;
  return path;
}

function hitsForbidden(path: string, forbidden: string): boolean {
  if (path === forbidden || path.startsWith(`${forbidden}/`)) return true;
  return path
    .split('/')
    .some(
      (part) =>
        part === forbidden || (forbidden.startsWith('.') && part.startsWith(`${forbidden}.`)),
    );
}

function inScope(path: string, scopes: readonly string[]): boolean {
  return scopes.some((scope) => path === scope || path.startsWith(`${scope}/`));
}

/** 生成范围、输出格式、禁止路径和 allowed-tools 的最小检查。 */
export function checkPromptConstraints(
  snapshot: PromptConstraintSnapshot,
  subject: ConstraintSubject,
): { readonly ok: true } | { readonly ok: false; readonly issues: readonly ConstraintIssue[] } {
  const frozen = readPromptConstraints(snapshot);
  const issues: ConstraintIssue[] = [];
  const seen = new Set<string>();
  for (const raw of [...(subject.paths ?? []), ...(subject.texts ?? []).flatMap(pathsIn)]) {
    const path = normalizePath(raw);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    if (frozen.limits.scopePaths.length && !inScope(path, frozen.limits.scopePaths)) {
      issues.push(issue('scope-exceeded', path, `路径 ${path} 超出生成范围。`));
    }
    for (const forbidden of frozen.limits.forbiddenPaths) {
      if (!hitsForbidden(path, forbidden)) continue;
      issues.push(issue('forbidden-path', path, `路径 ${path} 命中禁止路径 ${forbidden}。`));
      break;
    }
  }
  const expected = frozen.limits.outputFormat;
  if (expected) {
    if (subject.outputFormat && subject.outputFormat.toLowerCase() !== expected.toLowerCase()) {
      issues.push(
        issue('output-format-mismatch', subject.outputFormat, `输出格式必须是 ${expected}。`),
      );
    }
    if (subject.outputText !== undefined && expected.toLowerCase() === 'json') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(subject.outputText);
      } catch {
        parsed = undefined;
      }
      if (!parsed || typeof parsed !== 'object') {
        issues.push(issue('output-format-mismatch', 'output', '输出不是 JSON 对象或数组。'));
      }
    }
  }
  const limiting = frozen.skills.filter((skill) => skill.limitsTools);
  if (subject.tools && limiting.length) {
    const allowed = new Set(limiting.flatMap((skill) => skill.allowedTools));
    for (const tool of subject.tools) {
      if (!allowed.has(tool)) {
        issues.push(
          issue('tool-not-allowed', tool, `工具 ${tool} 不在已钉住 Skill 的 allowed-tools 中。`),
        );
      }
    }
  }
  return issues.length ? { ok: false, issues: Object.freeze(issues) } : { ok: true };
}

/** 草案节点上的范围、格式和禁止路径。失败时由规划校验抛出。 */
export function checkPlanningWorkflows(
  snapshot: PromptConstraintSnapshot,
  workflows: readonly { readonly nodes: readonly PlanningConstraintNode[] }[],
): readonly ConstraintIssue[] {
  const frozen = readPromptConstraints(snapshot);
  const issues: ConstraintIssue[] = [];
  for (const node of workflows.flatMap((workflow) => workflow.nodes)) {
    const checked = checkPromptConstraints(frozen, {
      texts: [node.title, node.description, node.input, node.output, node.rationale],
    });
    if (!checked.ok) {
      for (const item of checked.issues)
        issues.push({ ...item, target: `${node.id}:${item.target}` });
    }
    const format = frozen.limits.outputFormat;
    if (format && !node.output.toLowerCase().includes(format.toLowerCase())) {
      issues.push(
        issue(
          'output-format-mismatch',
          node.id,
          `「${node.title}」的交付说明未使用输出格式 ${format}。`,
        ),
      );
    }
  }
  return Object.freeze(issues);
}

/** 执行侧接受草稿前复核同一份快照。 */
export function acceptExecutionDraft(
  snapshot: PromptConstraintSnapshot,
  draft: {
    readonly text?: string;
    readonly paths?: readonly string[];
    readonly tools?: readonly string[];
  },
): PromptConstraintSnapshot {
  const frozen = readPromptConstraints(snapshot);
  const checked = checkPromptConstraints(frozen, {
    ...(draft.text !== undefined ? { texts: [draft.text], outputText: draft.text } : {}),
    ...(draft.paths ? { paths: [...draft.paths] } : {}),
    ...(draft.tools ? { tools: [...draft.tools] } : {}),
  });
  if (!checked.ok) {
    throw new PromptConstraintError(
      'constraint-violation',
      checked.issues.map((item) => `${item.code} ${item.target} ${item.reason}`).join('\n'),
      checked.issues,
    );
  }
  return frozen;
}
