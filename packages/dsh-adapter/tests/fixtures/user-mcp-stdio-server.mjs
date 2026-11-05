import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const callsFile = process.argv[2];

function note(name) {
  if (typeof callsFile === 'string' && callsFile.length > 0) appendFileSync(callsFile, `${name}\n`);
}

const handle = serveStdio(() => {
  const server = new McpServer({ name: 'user-mcp-fixture', version: '1.0.0' });
  server.registerTool(
    'echo',
    { description: '回显文本', inputSchema: z.object({ text: z.string() }) },
    async ({ text }) => {
      note('echo');
      return { content: [{ type: 'text', text }] };
    },
  );
  server.registerTool(
    'add',
    {
      description: '两数相加',
      inputSchema: z.object({ a: z.number(), b: z.number() }),
    },
    async ({ a, b }) => {
      note('add');
      return { content: [{ type: 'text', text: String(a + b) }] };
    },
  );
  server.registerTool('fail', { description: '固定失败', inputSchema: z.object({}) }, async () => {
    note('fail');
    return { content: [{ type: 'text', text: 'fixture-failed' }], isError: true };
  });
  return server;
});

process.on('SIGTERM', () => {
  void handle.close();
});
