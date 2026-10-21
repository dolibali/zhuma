import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const PACKAGE_DIRECTORIES = ['agent-core', 'context', 'dsh-adapter', 'client'];
export const fromRoot = (...segments) => path.join(ROOT, ...segments);
