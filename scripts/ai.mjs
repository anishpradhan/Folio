// Runs a command with the AI backend's virtualenv Python (Windows and POSIX layouts).
//   node scripts/ai.mjs            → start the backend (python -m folio_ai)
//   node scripts/ai.mjs test [...] → pytest
//   node scripts/ai.mjs e2e        → the hermetic backend the Playwright tests use (port 8766)
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const backend = resolve(import.meta.dirname, '..', 'backend');
const py = [resolve(backend, '.venv/Scripts/python.exe'), resolve(backend, '.venv/bin/python')].find(existsSync);
if (!py) {
  console.error('The AI backend is not installed. See backend/README.md (python -m venv backend/.venv; pip install -r backend/requirements.txt).');
  process.exit(1);
}
const [cmd, ...rest] = process.argv.slice(2);
const args = cmd === 'test' ? ['-m', 'pytest', '-q', ...rest] : cmd === 'e2e' ? ['-m', 'folio_ai.e2e'] : ['-m', 'folio_ai', ...process.argv.slice(2)];
const child = spawn(py, args, { cwd: backend, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
