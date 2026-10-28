import { randomUUID, createHash } from 'node:crypto';
import { REMOTE_RUN_UPLOAD_METHOD } from '../dist/remote-run-file-transport.js';
export function publicationEnvelope(bytes = new Uint8Array([0, 1, 255])) {
  const backendId = randomUUID();
  return {
    type: 'client-request',
    rpcId: randomUUID(),
    method: REMOTE_RUN_UPLOAD_METHOD,
    payload: {
      protocolVersion: 1,
      operation: 'publish-file',
      requestId: randomUUID(),
      backendId,
      deviceId: randomUUID(),
      proof: { issuedAt: Date.now(), nonce: randomUUID(), signature: 'a'.repeat(86) },
      payload: {
        scope: {
          backendId,
          actorId: 'member',
          spaceId: 'space',
          taskId: '任务',
          planId: 'plan',
          revision: 1,
          nodeId: 'node',
          runId: 'run',
          generation: 1,
          segmentId: 'segment',
        },
        permit: { id: randomUUID(), sha256: 'b'.repeat(64) },
        mode: 'publish',
        reservationId: randomUUID(),
        declare: {
          name: '产物.bin',
          mediaType: 'application/octet-stream',
          byteSize: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      },
    },
  };
}
