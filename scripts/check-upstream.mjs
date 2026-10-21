import { checkUpstream } from './lib/upstream.mjs';

try {
  const pin = checkUpstream();
  console.log(`DSH source pin OK: ${pin.ref} (${pin.commit})`);
  console.log(`Independent upstream toolchain: ${pin.packageManager}`);
  console.log('Source checks only; no desktop build or plugin integration was executed.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
