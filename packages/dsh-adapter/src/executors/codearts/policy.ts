import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@agentclientprotocol/sdk';
import type { CodeArtsPermissionRule } from './http.js';

export class CodeArtsPolicyError extends Error {
  constructor() {
    super('CodeArts requires the current scoped DSH HTTP bridge');
    this.name = 'CodeArtsPolicyError';
  }
}
export interface CodeArtsMcpPolicy {
  readonly agentName: string;
  readonly rules: readonly CodeArtsPermissionRule[];
  readonly tools: Readonly<Record<string, boolean>>;
  readonly processConfig: string;
}

/** Matches the fixed community bridge's transport, not a member/Run permission. */
export function createCodeArtsMcpPolicy(servers: readonly McpServer[]): CodeArtsMcpPolicy {
  if (servers.length !== 1) throw new CodeArtsPolicyError();
  const server = servers[0];
  if (
    !server ||
    !('type' in server) ||
    server.type !== 'http' ||
    !/^dshteam_[a-f0-9]{16}$/u.test(server.name) ||
    server.headers.length !== 0
  )
    throw new CodeArtsPolicyError();
  let url: URL;
  try {
    url = new URL(server.url);
  } catch {
    throw new CodeArtsPolicyError();
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.port === '0' ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !/^\/[a-f0-9]{64}$/u.test(url.pathname)
  )
    throw new CodeArtsPolicyError();
  const agentName = `zhuma-task-${randomUUID()}`;
  // CodeArts' actual tool IDs are sanitize(serverName) + '_' + toolName.
  const namespace = `${server.name}_*`;
  const tools = Object.freeze({ '*': false, [namespace]: true });
  const rules = Object.freeze([
    Object.freeze({ permission: '*', pattern: '*', action: 'deny' as const }),
    Object.freeze({ permission: namespace, pattern: '*', action: 'allow' as const }),
  ]);
  return Object.freeze({
    agentName,
    rules,
    tools,
    processConfig: JSON.stringify({
      agent: {
        [agentName]: {
          description: 'Current Zhuma task',
          mode: 'primary',
          prompt:
            "Use only this task's DSH MCP tools. Their real policies and approval requests apply. Unsupported native tools cannot be substituted.",
          permission: { '*': 'deny', [namespace]: 'allow' },
        },
      },
      mcp: { [server.name]: { type: 'remote', url: url.href, enabled: true } },
    }),
  });
}

export function codeArtsPromptText(blocks: readonly unknown[]): string {
  const texts = blocks.map((block) => {
    const text = z.object({ type: z.literal('text'), text: z.string() }).safeParse(block);
    if (text.success) return text.data.text;
    const resource = z
      .object({ type: z.literal('resource'), resource: z.object({ text: z.string() }) })
      .safeParse(block);
    if (resource.success) return resource.data.resource.text;
    throw new CodeArtsPolicyError();
  });
  const value = texts.join('\n\n');
  if (!value.trim() || Buffer.byteLength(value, 'utf8') > 2 * 1024 * 1024)
    throw new CodeArtsPolicyError();
  return value;
}
