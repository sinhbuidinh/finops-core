import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], {
  encoding: 'utf8',
}).split('\0').filter(Boolean);
const changedSource = staged.filter((file) => file.startsWith('src/') && file.endsWith('.ts') && !file.endsWith('.spec.ts'));

const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
const args = [vitest, 'run', ...(changedSource.length ? ['--coverage'] : [])];
const env = { ...process.env };
if (changedSource.length) env.COVERAGE_FILES = JSON.stringify(changedSource);

console.log(changedSource.length
  ? `Running the test suite and enforcing coverage for ${changedSource.length} changed source file(s).`
  : 'Running the test suite (no changed production TypeScript files require coverage).');
execFileSync(process.execPath, args, { stdio: 'inherit', env });
