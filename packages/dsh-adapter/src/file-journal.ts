import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface DeskJournal<T> {
  load(): T | null;
  save(value: T): void;
}

/** 运行时日志。调用方负责把路径放在临时目录，不要提交这份文件。 */
export function createFileJournal<T>(filePath: string): DeskJournal<T> {
  return {
    load() {
      try {
        return JSON.parse(readFileSync(filePath, 'utf8')) as T;
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        if (code === 'ENOENT') return null;
        throw error;
      }
    },
    save(value: T) {
      mkdirSync(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(value));
      renameSync(temporary, filePath);
    },
  };
}
