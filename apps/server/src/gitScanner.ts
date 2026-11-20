import { promises as fs } from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { allowedPath, digestFile, idFor, protectedPath, readSmall } from '../../../local/paths.mjs';

// Adapted from repo-control's findGitRepos, readProjectSummary and bounded workers.
const IGNORED_DIRS = new Set([
  '.cache',
  '.git',
  '.idea',
  '.next',
  '.turbo',
  '.venv',
  'bin',
  'build',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
  'coverage',
  '__pycache__',
  'DerivedData',
  'Pods',
  'logs',
  'Logs',
]);
export const ignoredDir = (name: string) => name.startsWith('.') || IGNORED_DIRS.has(name);
export const ordinaryFile = (name: string) =>
  !name.startsWith('.') &&
  !name.startsWith('~$') &&
  !/\.(?:log(?:\.\d+)?|jsonl|lock|tmp|swp|sqlite(?:-\w+)?|db|pyc|class|o)$/i.test(name) &&
  !['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'].includes(name);

async function gitIdentity(dir, marker, roots) {
  const dot = path.join(dir, '.git');
  if (marker.isSymbolicLink() || !(await allowedPath(dot, roots))) throw Error('Git 元数据不在授权范围');
  let gitDir = dot;
  if (marker.isFile()) {
    const match = /^gitdir: (.+)$/.exec((await readSmall(dot, 8192)).trim());
    if (!match) throw Error('无法识别 Git 工作树');
    gitDir = path.resolve(dir, match[1]);
  }
  if (!(await allowedPath(gitDir, roots))) throw Error('需同时授权主仓库目录');
  let common = gitDir;
  const pointer = path.join(gitDir, 'commondir');
  const meta = await fs.lstat(pointer).catch((e) => {
    if (e.code !== 'ENOENT') throw e;
  });
  if (meta) {
    if (!meta.isFile() || !(await allowedPath(pointer, roots))) throw Error('Git 公共目录未核实');
    common = path.resolve(gitDir, (await readSmall(pointer, 8192)).trim());
  }
  if (!(await allowedPath(common, roots))) throw Error('需同时授权 Git 公共目录');
  return { id: idFor('git', common), gitDir, common };
}

async function readProjectSummary(row, roots) {
  try {
    if (
      !(await allowedPath(row.path, roots)) ||
      !(await allowedPath(row.gitDir, roots)) ||
      !(await allowedPath(row.common, roots))
    )
      throw Error();
    const git = simpleGit({
      baseDir: row.path,
      binary: '/usr/bin/git',
      timeout: { block: 10000 },
      config: ['gc.auto=0', 'maintenance.auto=false', 'log.showSignature=false'],
    }).env({
      PATH: '/usr/bin:/bin',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: '/var/empty',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_LAZY_FETCH: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ALLOW_PROTOCOL: '',
      GIT_DIR: row.gitDir,
      GIT_WORK_TREE: row.path,
      GIT_COMMON_DIR: row.common,
    });
    const branch = (
      await git.raw(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')
    ).trim();
    const log = (
      await git
        .raw([
          'log',
          '-1',
          '--no-show-signature',
          '--no-notes',
          '--no-decorate',
          '--format=%H%x00%ct%x00%s',
          'HEAD',
        ])
        .catch(async (e) => {
          // An unborn branch has no first commit yet.
          if (
            branch &&
            !(await git.raw(['show-ref', '--verify', 'refs/heads/' + branch]).catch(() => '')).trim()
          )
            return '';
          throw e;
        })
    )
      .trim()
      .split('\0');
    row.git = {
      branch: branch || '分离 HEAD',
      hash: log[0] || '',
      date: Number(log[1] || 0) * 1000,
      subject: (log[2] || '').slice(0, 400),
    };
  } catch {
    row.error = 'Git 摘要未核实';
  }
}

// A directory with loose files is one candidate. A nested .git starts its own source.
// At a selected container root, loose files and child projects remain independently selectable.
export async function scanProjects(roots, moreDirectories = [], previous = new Map()) {
  const units = new Map(),
    issues = [];
  const visited = new Set();
  const explicit = new Set(roots.map((root) => root.path));
  const hinted = new Set(moreDirectories);
  async function visit(dir, owner = null) {
    if (visited.has(dir) || protectedPath(dir)) return;
    visited.add(dir);
    if (!(await allowedPath(dir, roots))) {
      issues.push(dir);
      return;
    }
    const entries = await settleWithin(fs.readdir(dir, { withFileTypes: true }), 8000).catch(() => null);
    if (!entries) {
      issues.push(dir);
      return;
    }
    const marker = entries.find((entry) => entry.name === '.git');
    const files = entries.filter((e) => e.isFile() && ordinaryFile(e.name));
    let row = owner;
    if (marker) {
      let identity;
      try {
        identity = await gitIdentity(dir, marker, roots);
      } catch (e) {
        identity = { id: idFor('unverified', dir), error: e.message };
      }
      row = { ...identity, path: dir, kind: 'git', files: {} };
      units.set(dir, row);
    } else if (!row && (files.length || hinted.has(dir))) {
      row = { id: idFor('dir', dir), path: dir, kind: 'directory', files: {} };
      units.set(dir, row);
    }
    if (row) {
      const prior = previous.get(row.path)?.files || {};
      const observations = await mapWithConcurrency(files, 6, async (entry) => {
        const full = path.join(dir, entry.name);
        try {
          const stat = await fs.lstat(full);
          if (!stat.isFile()) return null;
          const old = prior[full],
            mtime = Math.round(stat.mtimeMs);
          if (
            old &&
            old[1] === stat.size &&
            old[3] === stat.ctimeMs &&
            old[4] === stat.ino &&
            old[0] === mtime
          )
            return [full, old];
          // shortcut: for files over 8 MiB, use size changes for discovery; hash the entire file when a receipt cites it.
          const digest = stat.size <= 8 * 1024 * 1024 ? await digestFile(full) : null;
          return [full, [mtime, stat.size, digest, stat.ctimeMs, stat.ino]];
        } catch (e) {
          if (e.code !== 'ENOENT') issues.push(full);
          return null;
        }
      });
      for (const item of observations) if (item) row.files[item[0]] = item[1];
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || ignoredDir(entry.name)) continue;
      const next = path.join(dir, entry.name);
      if (explicit.has(next)) continue;
      // A root-level README frequently describes a whole collection of projects.
      const childOwner = row?.kind === 'directory' && explicit.has(dir) ? null : row;
      await visit(next, childOwner);
    }
  }
  for (const root of roots) await visit(root.path);
  const rows = [...units.values()];
  await mapWithConcurrency(
    rows.filter((row) => row.gitDir),
    4,
    (row) => readProjectSummary(row, roots),
  );
  return { rows, issues };
}
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapItem: (item: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length && !signal?.aborted) {
      const itemIndex = nextIndex;
      nextIndex += 1;
      results[itemIndex] = await mapItem(items[itemIndex]);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return signal?.aborted
    ? results.slice(0, nextIndex).filter((result): result is R => result !== undefined)
    : results;
}

function settleWithin<T>(operation: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Project scan cancelled'));
      return;
    }

    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(signal?.reason ?? new Error('Project scan cancelled')));
    const timeout = setTimeout(
      () => finish(() => reject(new Error('Filesystem operation timed out'))),
      timeoutMs,
    );
    timeout.unref();

    signal?.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}
