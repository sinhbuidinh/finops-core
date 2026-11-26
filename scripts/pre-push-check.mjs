import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pushedRefs = readFileSync(0, 'utf8').trim().split(/\r?\n/).filter(Boolean);
const changedFiles = new Set();

for (const line of pushedRefs) {
  const [localRef, localSha, , remoteSha] = line.split(/\s+/);
  if (!localRef?.startsWith('refs/heads/') || !localSha || /^0+$/.test(localSha)) continue;

  const args = /^0+$/.test(remoteSha ?? '')
    // A new branch has no remote base; verify the latest commit being pushed.
    ? ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', localSha]
    : ['diff', '--name-only', '--diff-filter=ACMR', `${remoteSha}..${localSha}`];
  const files = execFileSync('git', args, { encoding: 'utf8' });
  for (const file of files.split(/\r?\n/).filter(Boolean)) changedFiles.add(file);
}

const changedSource = [...changedFiles].filter(
  (file) => file.startsWith('src/') && file.endsWith('.ts') && !file.endsWith('.spec.ts'),
);
const env = { ...process.env };
if (changedSource.length) env.COVERAGE_FILES = JSON.stringify(changedSource);

const nest = fileURLToPath(new URL('../node_modules/@nestjs/cli/bin/nest.js', import.meta.url));
const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));

console.log('Building the app before push.');
const buildInfo = fileURLToPath(new URL('../tsconfig.build.tsbuildinfo', import.meta.url));
const previousBuildInfo = existsSync(buildInfo) ? readFileSync(buildInfo) : undefined;
try {
  execFileSync(process.execPath, [nest, 'build'], { stdio: 'inherit', env });
} finally {
  if (previousBuildInfo) writeFileSync(buildInfo, previousBuildInfo);
}
console.log(changedSource.length
  ? `Running the test suite and enforcing coverage for ${changedSource.length} pushed source file(s).`
  : 'Running the test suite (no changed production TypeScript files require coverage).');
execFileSync(process.execPath, [vitest, 'run', ...(changedSource.length ? ['--coverage'] : [])], { stdio: 'inherit', env });
