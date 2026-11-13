// Intermediate process: spawns claude (own process group) with piped stdio, forwards output, prints CHILD_PID to stderr.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const child = spawn('claude', cfg.args, { cwd: cfg.cwd, env: cfg.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
process.stderr.write(`CHILD_PID ${child.pid}\n`);
child.stdout.on('data', (d) => process.stdout.write(d));
child.stderr.on('data', (d) => process.stderr.write(d));
child.stdin.write(cfg.prompt);
child.stdin.end();
child.on('close', (c, s) => { process.stderr.write(`CHILD_EXIT ${c} ${s}\n`); process.exit(0); });
setInterval(() => {}, 1000);
