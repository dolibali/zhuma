import { Readable, Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { CodeArtsAcpAgent } from './agent.js';

const { values } = parseArgs({
  options: { 'codearts-command': { type: 'string' } },
  strict: true,
  allowPositionals: false,
});
if (!values['codearts-command']) throw new Error('CodeArts launcher required');
let agent: CodeArtsAcpAgent | undefined;
const lifetime = new AbortController();
const stop = (): void => lifetime.abort();
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
const connection = new AgentSideConnection(
  (conn) =>
    (agent = new CodeArtsAcpAgent({
      command: values['codearts-command']!,
      signal: lifetime.signal,
      connection: conn,
    })),
  // Node's standard Web Stream has a parallel declaration in @types/node.
  ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  ),
);
// The legacy SDK invokes the factory before its private connection is assigned.
connection.signal.addEventListener('abort', stop, { once: true });
if (connection.signal.aborted) stop();
try {
  await Promise.race([
    connection.closed,
    new Promise<void>((resolve) =>
      lifetime.signal.addEventListener('abort', () => resolve(), { once: true }),
    ),
  ]);
} finally {
  await agent?.dispose();
  process.stdin.destroy();
  connection.signal.removeEventListener('abort', stop);
  process.removeListener('SIGTERM', stop);
  process.removeListener('SIGINT', stop);
}
