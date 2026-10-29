/** Original native SDK plus real Service/JSON/AttachmentLocal/HTTP and private
 * CredentialsLocal. Member lease and HTTP mount below remain explicit contracts. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Credentials from '@deepseek-ai/dsh-credentials-local';
import {
  REMOTE_RUN_OPERATIONS,
  REMOTE_RUN_PERMIT_HEADER,
  remoteExecutionRequestSchema,
} from '@zhuma/agent-core';
import { MemberLocalExecutionProtocol } from '../dist/member-local-execution-protocol.js';
import { MemberLocalReviewProtocol } from '../dist/member-local-review-protocol.js';
import { MemberLocalExecutionSecrets } from '../dist/member-local-execution-secrets.js';
import { createMemberLocalPrivateStore } from '../dist/host-member-local-credentials.js';
import { readExecutionReviewState } from '../dist/execution-review-state.js';
import { reviewHost } from './remote-review-fixture.mjs';
import { bootLocalOwner, toolResponse, response } from './member-local-execution-owner-fixture.mjs';
export { toolResponse, response, readExecutionReviewState };
export async function bootMemberLocalReview(root, after, options = {}) {
  const backend = await reviewHost({ after }, { file: true }),
    credentials = new Context(),
    life = new AbortController();
  await credentials.plugin(Credentials, { path: join(root, 'credentials.yaml'), watch: false });
  const methods = Object.fromEntries(
      REMOTE_RUN_OPERATIONS.map((op) => [op, `zhuma-sdk-review/${op}`]),
    ),
    seen = [];
  const server = createServer(async (request, response) => {
    try {
      let text = '';
      for await (const bytes of request) text += bytes;
      const envelope = JSON.parse(text),
        body = remoteExecutionRequestSchema.parse(envelope.payload);
      assert.equal(request.url, `/api/${methods[body.operation]}`);
      assert.equal(request.headers.cookie, backend.request.headers.cookie);
      await options.beforeRequest?.(body);
      const result = await backend.service.remoteRun(
        backend.request,
        body,
        request.headers[REMOTE_RUN_PERMIT_HEADER],
      );
      seen.push({
        operation: body.operation,
        purpose: body.purpose,
        payload: structuredClone(body.payload),
        result: structuredClone(result),
        ballots: backend.read().rounds[0].ballots.length,
      });
      await options.beforeReply?.(body, result);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result }));
    } catch {
      if (!response.destroyed) response.writeHead(503).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const config = {
      origin: `http://127.0.0.1:${server.address().port}`,
      methods,
      expectedActorId: 'chen',
      authentication: () => ({ cookie: backend.request.headers.cookie }),
      secrets: new MemberLocalExecutionSecrets(
        createMemberLocalPrivateStore(credentials, life.signal),
      ),
    },
    protocol = await MemberLocalExecutionProtocol.open(config),
    review = await MemberLocalReviewProtocol.open(config),
    h = await bootLocalOwner(root, protocol, { ...options, review: { protocol: review } });
  after(async () => {
    await h.close();
    await review.close();
    await protocol.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    life.abort();
    await credentials.fiber.dispose();
  });
  const { credentials: _credentials, ...input } = backend.accept().payload;
  const reopen = async () => {
    await h.close();
    const coldReview = await MemberLocalReviewProtocol.open(config);
    const cold = await bootLocalOwner(root, protocol, {
      review: { protocol: coldReview },
      assertModel: () => assert.fail('cold history cannot resolve a model'),
    });
    after(async () => {
      await cold.close();
      await coldReview.close();
    });
    return { ...cold, review: coldReview };
  };
  return { ...h, root, backend, protocol, review, input, seen, reopen };
}
