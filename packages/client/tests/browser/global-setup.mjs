import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

export default function globalSetup() {
  execFileSync('pnpm', ['exec', 'tsc', '-b', '--pretty', 'false'], {
    cwd: root,
    stdio: 'inherit',
  });
}
