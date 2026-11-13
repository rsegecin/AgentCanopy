import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as esbuild from 'esbuild';

const args = new Set(process.argv.slice(2));
const production = args.has('--production');
const watch = args.has('--watch');
const tests = args.has('--tests');

/** Recursively lists files under `dir` whose names end with `suffix`. */
function findFiles(dir, suffix) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return findFiles(full, suffix);
    return entry.name.endsWith(suffix) ? [full] : [];
  });
}

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  sourcemap: true,
  minify: production,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions[]} */
let configs;

if (tests) {
  // Keep the subfolders: the integration runner selects whole folders (see .vscode-test.mjs).
  const entryPoints = findFiles('test/integration', '.test.ts').map((file) => ({
    in: file,
    out: relative('test/integration', file).split(/[\\/]/).join('/').replace(/\.ts$/, ''),
  }));
  if (existsSync('dist-test/integration')) {
    rmSync('dist-test/integration', { recursive: true, force: true });
  }
  configs = [
    {
      ...common,
      minify: false,
      entryPoints,
      outdir: 'dist-test/integration',
      outExtension: { '.js': '.cjs' },
      format: 'cjs',
      platform: 'node',
      target: 'node22',
      external: ['vscode'],
    },
  ];
} else {
  // Chunk names carry content hashes, so stale ones from earlier builds must not pile up.
  rmSync('dist/webview', { recursive: true, force: true });
  configs = [
    {
      ...common,
      entryPoints: ['src/vscode/extension.ts'],
      outfile: 'dist/extension.js',
      format: 'cjs',
      platform: 'node',
      target: 'node22',
      external: ['vscode'],
    },
    {
      ...common,
      entryPoints: ['src/webview/app/main.tsx'],
      outdir: 'dist/webview',
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      splitting: true,
      chunkNames: 'chunks/[name]-[hash]',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
      loader: { '.ttf': 'file', '.css': 'css' },
      // See scripts/stubs/elk.mjs: the ELK layout engine is left out on purpose.
      alias: { 'elkjs/lib/elk.bundled.js': './scripts/stubs/elk.mjs' },
    },
  ];
}

if (watch) {
  const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('esbuild: watching for changes');
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
