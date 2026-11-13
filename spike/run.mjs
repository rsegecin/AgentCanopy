#!/usr/bin/env node
// Usage: node spike/run.mjs <scenario-id|all> | --check [id] [--verbose] | --fixtures
import { scenarios, ORDER } from './scenarios.mjs';

const [a, b, c] = process.argv.slice(2);
if (a === '--check') {
  const { check } = await import('./check.mjs');
  check(b && !b.startsWith('--') ? b : null, process.argv.includes('--verbose'));
} else if (a === '--fixtures') {
  const { writeFixtures } = await import('./fixtures.mjs');
  writeFixtures();
} else if (a === 'all') {
  for (const id of ORDER) { console.log(`=== ${id}`); await scenarios[id](); }
} else if (a && scenarios[a]) {
  await scenarios[a]();
} else {
  console.error(`usage: run.mjs <${[...ORDER, 'D1', 'D1a..D1e', 'all'].join('|')}> | --check [id] [--verbose] | --fixtures`);
  process.exit(2);
}
