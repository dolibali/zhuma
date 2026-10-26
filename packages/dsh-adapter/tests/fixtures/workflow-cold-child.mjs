/** New OS process, real original JSON; synthetic workbench/member authority. */
import { openWorkflowContract } from '../execution-workflow-fixture.mjs';
import { businessHashes } from '../execution-native-result-service-fixture.mjs';
const [root, rawWorkbench] = process.argv.slice(2);
const before = await businessHashes(root);
const h = await openWorkflowContract(root, { workbench: JSON.parse(rawWorkbench) });
try {
  const read = await h.service.readWorkflowExecution(h.request, h.location);
  if (!read.ok) throw Error(read.error.code);
  const replay = await h.service.startWorkflowExecution(h.request, h.startBody());
  const claim = await h.claim(read.value);
  const afterRead = await businessHashes(root);
  h.resetCounts();
  const resume = await h.service.resumeWorkflowExecution(h.request, {
    ...h.control(read.value, 'cold-explicit-resume'),
    expectedVersion: read.value.intent.version,
  });
  await h.close();
  process.send({ before, afterRead, read, replay, claim, resume, counters: h.counters });
} finally {
  await h.close();
  process.disconnect();
}
