import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const typescript = fileURLToPath(
  new URL('../../../../node_modules/typescript/bin/tsc', import.meta.url),
);

export default function globalSetup() {
  execFileSync(process.execPath, [typescript, '-b', '--pretty', 'false'], {
    cwd: root,
    stdio: 'inherit',
  });
}
