import { spawn } from 'node:child_process';
import process from 'node:process';

const env = { ...process.env, PORT: '3900' };
const server = spawn(process.execPath, ['server/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.pipe(process.stdout);
server.stderr.pipe(process.stderr);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await wait(1200);

const python = process.platform === 'win32' ? 'python' : 'python3';
const tests = spawn(python, ['test_e2e.py'], { stdio: 'inherit' });
const exitCode = await new Promise((resolve) => tests.on('exit', (code) => resolve(code ?? 1)));
server.kill('SIGTERM');
process.exit(exitCode);
