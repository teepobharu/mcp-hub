import { build } from 'esbuild';
import { existsSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';

function git(args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function getPatchManifest() {
  if (!existsSync('PATCHES.json')) return [];
  const patches = JSON.parse(readFileSync('PATCHES.json', 'utf8'));
  if (!Array.isArray(patches)) throw new Error('PATCHES.json must be an array');
  return patches.map(({ name, sha256, appliedAt }) => ({ name, sha256, appliedAt }));
}

function getBuildInfo(version) {
  const commit = git(['rev-parse', 'HEAD']);
  const releaseTag = git(['describe', '--tags', '--abbrev=0', '--match', 'v*']);
  const releaseTagCommitDate = releaseTag ? git(['log', '-1', '--format=%cI', releaseTag]) : null;
  const status = git(['status', '--porcelain', '--untracked-files=normal']);
  const changelog = releaseTag
    ? (git(['log', '--format=%h%x00%cI%x00%s', '-n', '50', `${releaseTag}..HEAD`]) || '')
      .split('\n')
      .filter(Boolean)
      .map((entry) => {
        const [commit, committedAt, subject] = entry.split('\0');
        return { commit, committedAt, subject };
      })
    : [];
  return {
    version,
    commit,
    shortCommit: commit?.slice(0, 7) || null,
    branch: git(['symbolic-ref', '--short', '-q', 'HEAD']),
    commitSubject: git(['log', '-1', '--format=%s']),
    commitDate: git(['log', '-1', '--format=%cI']),
    dirty: status === null ? null : status.length > 0,
    builtAt: new Date().toISOString(),
    releaseTag,
    releaseTagCommitDate,
    changelog,
    patches: getPatchManifest(),
  };
}

async function buildApp() {
  try {
    // Read version from package.json
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const version = pkg.version;
    const buildInfo = getBuildInfo(version);

    const result = await build({
      entryPoints: ['src/utils/cli.js'],
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'esm',
      outfile: 'dist/cli.js',
      banner: {
        js: `
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
globalThis.require = require;
`
      },
      external: [
        // These packages will be bundled
        // '@modelcontextprotocol/sdk',
        // 'express',
        // 'yargs',
        // 'reconnecting-eventsource',
      ],
      define: {
        'process.env.NODE_ENV': '"production"',
        'process.env.VERSION': JSON.stringify(version), // Inject version from package.json
        '__MCP_HUB_BUILD_INFO__': JSON.stringify(buildInfo),
      },
      minify: true,
      sourcemap: false,
    });
    console.log('Build complete!', result);
  } catch (err) {
    console.error('Build failed:', err);
    process.exit(1);
  }
}

buildApp();
