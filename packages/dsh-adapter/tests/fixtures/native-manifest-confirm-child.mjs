/** Fresh OS process and real original JSON. No completion issuer or byte provider. */
import { openManifestContract } from '../execution-native-manifest-fixture.mjs';
import { businessHashes } from '../execution-native-result-service-fixture.mjs';
const [root, encoded] = process.argv.slice(2);
const before = await businessHashes(root);
const h = await openManifestContract(root, { readerOnly: true });
try {
  const result = await h.service.confirmNativeResultDelivery(h.request, JSON.parse(encoded));
  const artifacts = h.read().artifactVersions.length;
  await h.close();
  process.send({
    result,
    counters: h.counters,
    before,
    after: await businessHashes(root),
    artifacts,
  });
} finally {
  await h.close();
  process.disconnect();
}
