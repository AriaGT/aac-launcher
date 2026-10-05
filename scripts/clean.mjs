/**
 * Clean the build output. Kept as a script rather than an npm chain so it works the
 * same on PowerShell, cmd and Git Bash.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = ['out', 'dist', 'release'];

for (const target of targets) {
  const full = path.join(root, target);
  if (!fs.existsSync(full)) continue;
  fs.rmSync(full, { recursive: true, force: true });
  console.log(`[clean] removed ${target}`);
}