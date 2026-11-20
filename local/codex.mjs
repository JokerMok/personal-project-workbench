import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, constants as sqlite } from 'node:sqlite';
import { allowedPath, codexDir, inside, systemPath } from './paths.mjs';

const idPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const fields = ['id', 'cwd', 'created_at', 'updated_at'];
const hidden = new Set(['.git', '.codex', '.ssh', 'node_modules']);

function sessionGrant(cwd, roots) {
  return roots
    .filter((root) => (root.exact ? root.path === cwd : inside(root.path, cwd)))
    .sort((a, b) => b.path.length - a.path.length || Number(!!b.exact) - Number(!!a.exact))[0];
}

export async function sessionCwd(value, roots) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.split('/').includes('..')) return '';
  const cwd = systemPath(value);
  if (cwd.split('/').some((part) => hidden.has(part))) return '';
  if (!sessionGrant(cwd, roots)?.sessions || !(await allowedPath(cwd, roots))) return '';
  return (await fs.stat(cwd).catch(() => null))?.isDirectory() ? cwd : '';
}

export function chatRoots(config) {
  return [...(config.chatDirs || []).map((dir) => ({ ...dir, sessions: true })), ...config.roots];
}

async function withIndex(extra, run) {
  if ((await fs.realpath(codexDir)) !== codexDir) throw Error('会话索引目录不可用');
  const names = (await fs.readdir(codexDir, { withFileTypes: true }))
    .filter((e) => e.isFile() && /^state_\d+\.sqlite$/.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => Number(b.split('_')[1].split('.')[0]) - Number(a.split('_')[1].split('.')[0]));
  if (!names.length) throw Error('会话索引不可用');
  const file = path.join(codexDir, names[0]);
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const st = await fs.lstat(file + suffix).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
    if (st && !st.isFile()) throw Error('会话索引文件类型异常');
  }
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000');
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='threads'").get())
      throw Error('会话索引结构不兼容');
    const available = new Set(
      db
        .prepare("SELECT name FROM pragma_table_info('threads')")
        .all()
        .map((r) => r.name),
    );
    const allowed = new Set([...fields, ...extra]);
    db.setAuthorizer?.((action, table, column) => {
      if (action === sqlite.SQLITE_READ)
        return table === 'threads' && allowed.has(column) ? sqlite.SQLITE_OK : sqlite.SQLITE_DENY;
      return action === sqlite.SQLITE_SELECT || action === sqlite.SQLITE_FUNCTION
        ? sqlite.SQLITE_OK
        : sqlite.SQLITE_DENY;
    });
    return await run(db, available);
  } finally {
    db.close();
  }
}

export async function readSessions(roots, { names = false, projects = false } = {}) {
  const grants = roots.filter((root) => root.sessions);
  if (!grants.length) return { status: '未接通', reason: '尚未授权会话元数据', rows: [] };
  try {
    return await withIndex(
      [...(names ? ['name'] : []), ...(projects ? ['project_id', 'archived', 'agent_role'] : [])],
      async (db, columns) => {
        const cwds = db.prepare(
          'SELECT DISTINCT cwd FROM threads WHERE cwd=? OR substr(cwd,1,length(?))=?',
        );
        const exactCwd = db.prepare('SELECT DISTINCT cwd FROM threads WHERE cwd=?');
        const extra = [
          ...(names ? ['name'] : []),
          ...(projects ? ['project_id', 'archived', 'agent_role'] : []),
        ];
        const projection = extra
          .filter((field) => columns.has(field))
          .map((field) => ',' + field)
          .join('');
        const metadata = db.prepare(
          'SELECT id,created_at,updated_at' + projection + ' FROM threads WHERE cwd=?',
        );
        const checked = new Set();
        const rows = [];
        for (const root of grants) {
          if (!(await allowedPath(root.path, roots))) continue;
          const aliases = new Set([
            root.path,
            root.path.replace(/^\/private\/(var|tmp)(?=\/|$)/, '/$1'),
          ]);
          for (const alias of aliases) {
            const prefix = alias.endsWith('/') ? alias : alias + '/';
            const candidates = root.exact ? exactCwd.all(alias) : cwds.all(alias, prefix, prefix);
            for (const { cwd } of candidates) {
              if (checked.has(cwd)) continue;
              checked.add(cwd);
              const real = await sessionCwd(cwd, roots);
              if (!real) continue;
              for (const item of metadata.all(cwd)) {
                if (
                  typeof item.id !== 'string' ||
                  !idPattern.test(item.id) ||
                  (projects && item.agent_role)
                )
                  continue;
                rows.push({
                  id: item.id,
                  cwd: real,
                  created: Number(item.created_at) * 1000,
                  updated: Number(item.updated_at) * 1000,
                  ...(names && {
                    name: String(item.name || '')
                      .trim()
                      .slice(0, 160),
                  }),
                  ...(projects && { projectId: item.project_id || null, archived: item.archived === 1 }),
                });
              }
            }
          }
        }
        return { status: '已接通', reason: 'SQLite 只读元数据', rows };
      },
    );
  } catch {
    return { status: '未接通', reason: '本机会话索引不可用或结构不兼容', rows: [] };
  }
}

export async function readAssignedSessions(ids) {
  if (!ids.length) return [];
  return withIndex(['project_id', 'archived', 'agent_role'], (db, columns) => {
    if (!columns.has('project_id')) return [];
    const projected = ['project_id', 'archived', 'agent_role'].filter((key) => columns.has(key));
    const rows = db
      .prepare(
        'SELECT id,cwd,updated_at,' +
          projected.join(',') +
          ' FROM threads WHERE project_id IN (' +
          ids.map(() => '?').join(',') +
          ')',
      )
      .all(...ids);
    return rows
      .filter((row) => typeof row.id === 'string' && idPattern.test(row.id) && !row.agent_role)
      .map((row) => ({
        id: row.id,
        projectId: row.project_id,
        cwd: typeof row.cwd === 'string' && path.isAbsolute(row.cwd) ? systemPath(row.cwd) : '',
        updated: Number(row.updated_at) * 1000,
        archived: row.archived === 1,
      }));
  }).catch(() => []);
}

export async function lookupSession(id, roots) {
  if (typeof id !== 'string' || !idPattern.test(id)) throw Error('会话 ID 无效');
  return withIndex(['rollout_path', 'project_id'], async (db, columns) => {
    const index = db.prepare('SELECT cwd FROM threads WHERE id=?').get(id);
    const cwd = await sessionCwd(index?.cwd, roots);
    if (!cwd) throw Error('此会话不在当前授权范围内');
    if (!columns.has('rollout_path')) throw Error('当前索引无法核对会话历史路径');
    const loc = db
      .prepare(
        'SELECT rollout_path' +
          (columns.has('project_id') ? ',project_id' : '') +
          ' FROM threads WHERE id=? AND cwd=?',
      )
      .get(id, index.cwd);
    await assertRollout(loc?.rollout_path);
    return { id, cwd, projectId: loc?.project_id || null };
  });
}

export async function assertRollout(file) {
  if (
    typeof file !== 'string' ||
    !['sessions', 'archived_sessions'].some((dir) => inside(path.join(codexDir, dir), file)) ||
    path.normalize(file) !== file ||
    (await fs.realpath(file).catch(() => '')) !== file ||
    !(await fs.lstat(file).catch(() => null))?.isFile()
  )
    throw Error('会话历史路径无法核实');
}
