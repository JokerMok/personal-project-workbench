import path from 'node:path';
import { promises as fs } from 'node:fs';
import { allowedPath, canonicalRoot, idFor, inside, protectedPath, systemPath } from './paths.mjs';
import { chatRoots, readAssignedSessions, readSessions, sessionCwd } from './codex.mjs';
import { ignoredDir } from '../apps/server/src/gitScanner.ts';

const oneWeek = 7 * 86400000;
const pathOrder = (left, right) => right.path.length - left.path.length || left.rank - right.rank;
const physical = (name) =>
  typeof name === 'string' &&
  path.isAbsolute(name) &&
  !name.split('/').includes('..') &&
  !protectedPath(systemPath(name));

export class CodexProjects {
  constructor(board, chat) {
    this.board = board;
    this.chat = chat;
  }

  invalidate() {
    this.freshUntil = 0;
  }

  async snapshot() {
    if (this.cached && this.freshUntil > Date.now()) return this.cached;
    if (!this.pending)
      this.pending = this.collect()
        .then((data) => {
          this.cached = data;
          this.freshUntil = Date.now() + 10000;
          return data;
        })
        .finally(() => {
          this.pending = null;
        });
    return this.pending;
  }

  async collect() {
    const rpc = await this.chat.reader();
    const items = [];
    let cursor = null;
    do {
      const page = await rpc.call('project/list', { cursor, limit: 100 });
      for (const project of page.data) {
        const paths = project.roots
          .filter((root) => physical(root.path))
          .map((root) => systemPath(root.path));
        items.push({
          id: project.id,
          name: project.name,
          paths: [...new Set(paths)],
          position: project.position,
          parent: null,
          count: 0,
          directCount: 0,
          recentCount: 0,
          last: 0,
        });
      }
      cursor = page.nextCursor || null;
    } while (cursor);
    const byId = new Map(items.map((project) => [project.id, project]));
    const paths = items.flatMap((project) =>
      project.paths.map((dir, rank) => ({ path: dir, rank, id: project.id })),
    );
    paths.sort(pathOrder);
    for (const project of items) {
      const main = project.paths[0];
      if (!main) continue;
      project.parent =
        paths.find(
          (root) =>
            root.rank === 0 && root.id !== project.id && root.path !== main && inside(root.path, main),
        )?.id || null;
    }
    const source = paths.map((root) => ({ path: root.path, sessions: true }));
    // Registry roots are used here for counts. Chat authorization is checked independently for IDs and text.
    const [meta, assigned] = await Promise.all([
      readSessions(source, { projects: true }),
      readAssignedSessions(items.map((project) => project.id)),
    ]);
    const sessions = new Map([...meta.rows, ...assigned].map((row) => [row.id, row]));
    const rows = [];
    for (const session of sessions.values()) {
      const owner =
        byId.get(session.projectId) ||
        byId.get(paths.find((root) => inside(root.path, session.cwd))?.id);
      if (!owner) continue;
      rows.push({ ...session, owner: owner.id });
      owner.directCount += 1;
      for (let project = owner; project; project = byId.get(project.parent)) {
        project.count += 1;
        if (session.updated >= Date.now() - oneWeek) project.recentCount += 1;
        if (!session.archived) project.last = Math.max(project.last, session.updated);
      }
    }
    return { items, rows, byId, paths, countsVerified: meta.status === '已接通' || !paths.length };
  }

  async require(id) {
    const snapshot = await this.snapshot();
    const project = snapshot.byId.get(id);
    if (!project) throw Error('Codex 项目不存在或已移除');
    return { project, snapshot };
  }

  async directory(project, requested) {
    const cwd = await canonicalRoot(requested || project.paths[0]);
    const roots = project.paths.map((dir) => ({ path: dir }));
    if (!(await allowedPath(cwd, roots))) throw Error('目录不属于此 Codex 项目');
    return cwd;
  }

  async access({ projectId, cwd, recursive }) {
    const { project } = await this.require(projectId);
    const dir = await this.directory(project, cwd);
    if (typeof recursive !== 'boolean') throw Error('请选择会话授权范围');
    const dirs = [...(this.board.config.chatDirs || [])];
    const previous = dirs.findIndex((scope) => scope.path === dir);
    if (previous < 0) dirs.push({ path: dir, exact: !recursive });
    else if (recursive) dirs[previous] = { path: dir, exact: false };
    else return dir;
    await this.board.setChatDirs({ revision: this.board.config.revision, dirs });
    return dir;
  }

  async create({ name, cwd }) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 120)
      throw Error('请输入项目名称，最多 120 个字符');
    const dir = await canonicalRoot(cwd);
    this.invalidate();
    const { items } = await this.snapshot();
    const exists = items.find((project) => project.name === name.trim() && project.paths[0] === dir);
    if (exists) return exists.id;
    const rpc = await this.chat.reader();
    const { project } = await rpc.call('project/create', {
      idempotencyKey: idFor('project', dir + '\n' + name.trim()),
      name: name.trim(),
      roots: [{ path: dir }],
    });
    this.invalidate();
    return project.id;
  }

  async list() {
    const { items, countsVerified } = await this.snapshot();
    return { items, countsVerified };
  }

  belongs(snapshot, id, owner) {
    for (let project = snapshot.byId.get(owner); project; project = snapshot.byId.get(project.parent)) {
      if (project.id === id) return true;
    }
    return false;
  }

  async scoped(id, branch = '') {
    const { project, snapshot } = await this.require(id);
    const directory = branch ? await this.directory(project, branch) : '';
    const matches = snapshot.rows.filter((row) =>
      directory
        ? inside(directory, row.cwd) && project.paths.some((dir) => inside(dir, row.cwd))
        : this.belongs(snapshot, id, row.owner),
    );
    const index = await readSessions(chatRoots(this.board.config), { names: true, projects: true });
    const cached = new Map(snapshot.rows.map((row) => [row.id, row.owner]));
    const sessions = index.rows
      .filter((row) => {
        if (directory) return inside(directory, row.cwd);
        const owner =
          cached.get(row.id) ||
          (snapshot.byId.has(row.projectId)
            ? row.projectId
            : snapshot.paths.find((root) => inside(root.path, row.cwd))?.id);
        return this.belongs(snapshot, id, owner);
      })
      .sort((a, b) => b.updated - a.updated);
    return { project, snapshot, directory, matches, sessions };
  }

  async detail(id, branch, browse) {
    const { project, snapshot, directory, matches, sessions } = await this.scoped(id, branch);
    const cwd = directory || project.paths[0] || '';
    const exists = !!cwd && !!(await this.directory(project, cwd).catch(() => ''));
    const folders = [];
    if (browse && exists) {
      const children = await fs.readdir(await this.directory(project, cwd), { withFileTypes: true });
      for (const child of children) {
        if (!child.isDirectory() || ignoredDir(child.name)) continue;
        const full = path.join(cwd, child.name);
        if (protectedPath(full)) continue;
        const registered = snapshot.items.find((item) => item.paths[0] === full);
        folders.push({
          path: full,
          name: child.name,
          projectId: registered?.id || null,
          count: matches.filter((row) => inside(full, row.cwd)).length,
        });
      }
      folders.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));
    }
    const regions = directory ? [directory] : project.paths;
    const workbench = this.board
      .items()
      .filter(
        (item) =>
          !item.candidate &&
          item.locations.some((loc) => regions.some((root) => inside(root, loc.path))),
      );
    const active = await sessionCwd(cwd, chatRoots(this.board.config));
    return {
      project,
      cwd,
      exists,
      branch: directory,
      folders,
      countsVerified: snapshot.countsVerified,
      count: directory ? matches.length : project.count,
      directCount: directory
        ? matches.filter((row) => row.cwd === directory).length
        : project.directCount,
      last: directory
        ? matches.reduce((last, row) => (row.archived ? last : Math.max(last, row.updated)), 0)
        : project.last,
      recentCount: directory
        ? matches.filter((row) => row.updated >= Date.now() - oneWeek).length
        : project.recentCount,
      children: snapshot.items.filter((item) =>
        directory
          ? item.paths[0] &&
            item.paths[0] !== directory &&
            inside(directory, item.paths[0]) &&
            path.dirname(item.paths[0]) === directory
          : item.parent === id,
      ),
      sessions,
      allowed: !!active,
      workbench: workbench.map(({ id, name, goal, stage, next, flags, latest }) => ({
        id,
        name,
        goal,
        stage,
        next,
        flags,
        latest,
      })),
    };
  }
}
