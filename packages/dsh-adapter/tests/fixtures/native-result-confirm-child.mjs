/** New OS process: fresh contract member/real original manager/JSON, no C owner or ref. */
import { openResultContract, businessHashes } from '../execution-native-result-service-fixture.mjs';
const [root, encoded] = process.argv.slice(2);
const before = await businessHashes(root);
const h = await openResultContract(root, { readerOnly: true });
try {
  const result = await h.service.confirmNativeResultDelivery(h.request, JSON.parse(encoded));
  const record = h.read();
  await h.close();
  process.send({
    result,
    counters: h.counters,
    before,
    after: await businessHashes(root),
    counts: {
      artifacts: record.artifactVersions.length,
      rounds: record.rounds.length,
      receipts: record.receipts.length,
      events: record.events.length,
    },
  });
} finally {
  await h.close();
  process.disconnect();
}
