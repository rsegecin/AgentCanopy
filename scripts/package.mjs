// Production build, then `vsce package --no-dependencies`.
// With AGENTCANOPY_PUBLISHER set, package.json is rewritten temporarily and restored afterwards.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'package.json');
const original = readFileSync(manifestPath, 'utf8');
const publisher = process.env.AGENTCANOPY_PUBLISHER;

function restore() {
  writeFileSync(manifestPath, original);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${String(result.status)}`);
  }
}

process.on('SIGINT', () => {
  restore();
  process.exit(130);
});

try {
  run(process.execPath, [join(root, 'esbuild.mjs'), '--production']);
  // The licence texts of everything that was just bundled ship inside the VSIX.
  run(process.execPath, [join(root, 'scripts', 'third-party-licenses.mjs')]);
  if (publisher) {
    const manifest = JSON.parse(original);
    manifest.publisher = publisher;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  // The README's links point at documents shipped inside the VSIX, so they work in VS Code without
  // being rewritten to a repository address. Once package.json names a repository, the links can be
  // rewritten instead (see docs/publishing.md).
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const rewrite = manifest.repository ? [] : ['--no-rewrite-relative-links'];
  run('npx', ['vsce', 'package', '--no-dependencies', ...rewrite]);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  restore();
}
