import fs from 'node:fs';
import path from 'node:path';
import type { FsProbe } from '../shared/validation';

/** FsProbe backed by node:fs, used by the pure directory validation. */
export function createFsProbe(): FsProbe {
  return {
    stat(target: string): string | null {
      try {
        const resolved = path.resolve(target);
        if (!fs.existsSync(resolved)) return null;
        return resolved;
      } catch {
        return null;
      }
    },
    isDirectory(target: string): boolean {
      try {
        return fs.statSync(target).isDirectory();
      } catch {
        return false;
      }
    },
  };
}

export function isGitRepo(target: string): boolean {
  try {
    return fs.existsSync(path.join(target, '.git'));
  } catch {
    return false;
  }
}