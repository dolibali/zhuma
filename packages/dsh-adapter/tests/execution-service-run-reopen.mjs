import { open } from './execution-service-run-fixture.mjs';
const host = await open(process.argv[2], { seed: false, mount: false });
try {
  console.log(
    JSON.stringify({
      global: host.service.readRunGlobal(),
      node: host.read(),
      composition: host.service.readRunComposition(host.runLocator()),
      writes: host.counters,
    }),
  );
} finally {
  await host.close();
}
