import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { scanProjects } from '../apps/server/src/gitScanner.ts';
import { canonicalRoot, dataDir, receiptsDir, inside, rootFor } from './paths.mjs';
import { readSessions } from './codex.mjs';
import { readReceipts } from './receipts.mjs';

const byTime = (a, b) => b.at - a.at || Number(b.lane === 'receipt') - Number(a.lane === 'receipt');
const dedup = (items) => [...new Set(items)];
const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 24);
const gates = ['accepted', 'deployed'];
export const notifyTypes = ['blocked', 'review', 'conflict'];
function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    throw Error('请核对' + label);
  return value.trim();
}
function publicRow(row) {
  return {
    id: row.id,
    path: row.path,
    kind: row.kind,
    git: row.git,
    missing: !!row.missing,
    error: row.error || '',
    count: Object.keys(row.files).length,
    lastGood: row.lastGood,
  };
}
function summarizeChanges(row, prev, now) {
  const out = [];
  if (row.git?.hash && row.git.hash !== prev?.git?.hash) {
    out.push({
      key: 'git/' + row.id + '/' + row.git.hash,
      source: row.id,
      location: row.path,
      lane: 'git',
      at: row.git.date,
      origin: 'Git · ' + row.git.hash.slice(0, 8),
      title: row.git.subject || 'Git 提交',
      change: !!prev,
    });
  }
  const files = Object.entries(row.files);
  if (!prev) {
    const newest = files.reduce((a, b) => (!a || b[1][0] > a[1][0] ? b : a), null);
    if (newest && !row.git?.hash)
      out.push({
        key: 'base/' + row.id + '/' + hash(row.path),
        source: row.id,
        location: row.path,
        lane: 'baseline',
        at: newest[1][0],
        origin: '目录快照',
        title: '首次记录 ' + files.length + ' 个文件 · ' + path.basename(newest[0]),
        change: false,
      });
  } else {
    const changed = [],
      unverified = [];
    for (const [file, stat] of files) {
      const before = prev.files[file];
      if (!before || before[1] !== stat[1] || (before[2] && stat[2] && before[2] !== stat[2]))
        changed.push([file, before ? '修改' : '新增', stat]);
      else if ((!stat[2] || !before[2]) && before[0] !== stat[0]) unverified.push(file);
    }
    for (const file of Object.keys(prev.files))
      if (!Object.hasOwn(row.files, file)) changed.push([file, '移除', null]);
    if (unverified.length)
      out.push({
        key: 'unverified/' + row.id + '/' + now,
        source: row.id,
        location: row.path,
        lane: 'unverified',
        at: now,
        origin: '文件元数据',
        title: '内容变化未核实 · ' + path.relative(row.path, unverified[0]),
        change: false,
      });
    if (changed.length) {
      const [first, verb] = changed[0];
      const at = changed.reduce(
        (latest, entry) =>
          Math.max(latest, entry[2]?.[0] > prev.lastGood && entry[2][0] <= now ? entry[2][0] : now),
        0,
      );
      out.push({
        key: 'file/' + row.id + '/' + now + '/' + hash(JSON.stringify(changed)),
        source: row.id,
        location: row.path,
        lane: 'files',
        at,
        origin: '目录变更 · ' + path.basename(row.path),
        title:
          verb +
          ' ' +
          path.relative(row.path, first) +
          (changed.length > 1 ? ' 等 ' + changed.length + ' 项' : ''),
        change: true,
      });
    }
  }
  return out;
}

export class Board {
  constructor(db) {
    this.db = db;
    db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    );
    const load = (key, fallback) =>
      JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value || 'null') ??
      fallback;
    this.config = load('config', { revision: 0, roots: [], projects: [] });
    this.snapshot = load('snapshot', {
      rows: [],
      sessions: [],
      codex: { status: '未接通', reason: '尚未授权会话元数据' },
      issues: [],
      conflicts: {},
      scanned: 0,
    });
    this.events = new Map(
      db
        .prepare('SELECT key,value FROM events')
        .all()
        .map((row) => [row.key, JSON.parse(row.value)]),
    );
    this.sequence = 0;
  }
  static async open() {
    await fs.mkdir(receiptsDir, { recursive: true, mode: 0o700 });
    return new Board(new DatabaseSync(path.join(dataDir, 'workspace.sqlite')));
  }
  commit(key, value, events = []) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key, JSON.stringify(value));
      const stmt = this.db.prepare('INSERT OR IGNORE INTO events VALUES(?,?)');
      for (const e of events) if (!this.events.has(e.key)) stmt.run(e.key, JSON.stringify(e));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    for (const e of events) if (!this.events.has(e.key)) this.events.set(e.key, e);
    this[key] = value;
    this.sequence++;
  }
  checkRevision(n) {
    if (n !== this.config.revision) throw Error('设置已在其他页面更新，请重新打开本页');
  }
  async setRoots(input) {
    this.checkRevision(input.revision);
    if (!Array.isArray(input.roots) || input.roots.length > 100) throw Error('目录列表无效');
    const roots = [],
      seen = new Set();
    for (const raw of input.roots) {
      const dir = await canonicalRoot(raw.path);
      if (seen.has(dir)) throw Error('目录重复');
      if (!['个人', '工作'].includes(raw.category) || typeof raw.sessions !== 'boolean')
        throw Error('请核对目录归属及会话授权');
      seen.add(dir);
      roots.push({ path: dir, category: raw.category, sessions: raw.sessions });
    }
    this.commit('config', { ...this.config, roots, revision: this.config.revision + 1 });
  }
  async setChatDirs(input) {
    this.checkRevision(input.revision);
    if (!Array.isArray(input.dirs) || input.dirs.length > 100) throw Error('会话目录列表无效');
    const chatDirs = [];
    for (const dir of input.dirs) {
      const real = await canonicalRoot(dir.path);
      if (typeof dir.exact !== 'boolean') throw Error('请核对会话目录授权范围');
      if (chatDirs.some((item) => item.path === real)) throw Error('会话目录重复');
      chatDirs.push({ path: real, exact: dir.exact });
    }
    this.commit('config', { ...this.config, chatDirs, revision: this.config.revision + 1 });
  }
  async saveProject(input) {
    this.checkRevision(input.revision);
    const current = this.config.projects.find((p) => p.id === input.projectId);
    if (input.projectId && !current) throw Error('项目不存在');
    const members = dedup(Array.isArray(input.members) ? input.members : []);
    const taken = new Set(
      this.config.projects.filter((p) => p.id !== current?.id).flatMap((p) => p.members),
    );
    if (
      !members.length ||
      members.some(
        (id) =>
          taken.has(id) ||
          (!current?.members.includes(id) &&
            !this.snapshot.rows.some(
              (r) => r.id === id && !r.error && !r.missing && rootFor(r.path, this.config.roots),
            )),
      )
    )
      throw Error('请选择可归组的候选目录');
    const name = text(input.name, 100, '项目名称'),
      goal = text(input.goal, 360, '当前里程碑');
    const criteria = (input.criteria || '').trim().slice(0, 900);
    const required = dedup(
      (Array.isArray(input.required) ? input.required : []).map((s) => text(s, 400, '验收文件')),
    );
    if (
      !required.length ||
      required.length > 32 ||
      required.some((s) => path.isAbsolute(s) || s.split('/').some((v) => !v || v.startsWith('.')))
    )
      throw Error('验收文件请使用项目内的相对路径，每行一个');
    if (!['个人', '工作'].includes(input.category) || !gates.includes(input.gate))
      throw Error('请核对项目分类和交付规则');
    if (!Array.isArray(input.notify) || input.notify.some((k) => !notifyTypes.includes(k)))
      throw Error('提醒条件无效');
    const sessionList = this.snapshot.sessions.filter((s) => members.includes(s.owner));
    const ignored = dedup(
      (input.ignored || []).filter(
        (s) => current?.ignored.includes(s) || sessionList.some((item) => item.id === s),
      ),
    );
    const newStage =
      !current ||
      goal !== current.goal ||
      input.gate !== current.gate ||
      criteria !== current.criteria ||
      JSON.stringify(required) !== JSON.stringify(current.required);
    const now = Date.now();
    const project = {
      id: current?.id || 'p-' + randomUUID(),
      name,
      category: input.category,
      goal,
      criteria,
      required,
      gate: input.gate,
      initialNext: (input.initialNext || '').trim().slice(0, 500),
      notify: dedup(input.notify),
      members,
      ignored,
      milestoneId: newStage ? 'm-' + randomUUID() : current.milestoneId,
      started: newStage ? now : current.started,
      previousMilestones: current
        ? [...current.previousMilestones, ...(newStage ? [current.milestoneId] : [])]
        : [],
    };
    await fs.mkdir(path.join(receiptsDir, project.id), { recursive: true, mode: 0o700 });
    const projects = this.config.projects.map((p) => (p.id === project.id ? project : p));
    if (!current) projects.push(project);
    const event = {
      key: 'setup/' + randomUUID(),
      source: project.id,
      milestoneId: project.milestoneId,
      lane: 'setup',
      at: now,
      title: (newStage ? '确认里程碑 · ' : '更新归组 · ') + goal,
      origin: '用户确认',
      detail: project.criteria,
    };
    this.commit('config', { ...this.config, projects, revision: this.config.revision + 1 }, [event]);
    return project.id;
  }
  async scan(reason) {
    const now = Date.now(),
      roots = this.config.roots,
      prev = this.snapshot;
    const meta = await readSessions(roots);
    const priorRows = new Map(prev.rows.map((r) => [r.path, r]));
    const hints = [
      ...meta.rows.map((s) => s.cwd),
      ...prev.rows.filter((r) => r.kind === 'directory').map((r) => r.path),
    ];
    const { rows, issues } = await scanProjects(roots, hints, priorRows);
    const pending = [],
      seen = new Set();
    for (const row of rows) {
      seen.add(row.path);
      const old = priorRows.get(row.path);
      const same = old?.id === row.id ? old : null;
      row.found = same?.found || now;
      const partial = issues.some((p) => inside(row.path, p));
      if (partial) row.error ||= '部分目录未核实';
      if (partial && same) row.files = { ...same.files, ...row.files };
      if (row.error && same?.git && !row.git) row.git = same.git;
      row.lastGood = row.error ? same?.lastGood || 0 : now;
      if (!row.error) pending.push(...summarizeChanges(row, same, now));
    }
    const members = new Set(this.config.projects.flatMap((p) => p.members));
    for (const old of prev.rows) {
      if (
        !seen.has(old.path) &&
        rootFor(old.path, roots) &&
        (members.has(old.id) || issues.some((p) => inside(p, old.path)))
      )
        rows.push({ ...old, missing: true, error: '目录不可用，保留上次记录' });
    }
    const locations = [...rows].sort((a, b) => b.path.length - a.path.length);
    const lastSessions = new Map(prev.sessions.map((s) => [s.id, s]));
    const available = meta.status === '已接通';
    const currentIds = new Set(meta.rows.map((s) => s.id));
    const observed = [
      ...meta.rows,
      ...prev.sessions.filter((s) => !currentIds.has(s.id)).map((s) => ({ ...s, verified: false })),
    ];
    const sessions = observed
      .filter((s) => rootFor(s.cwd, roots)?.sessions)
      .flatMap((s) => {
        const owner = locations.find((r) => inside(r.path, s.cwd));
        if (!owner) return [];
        if (currentIds.has(s.id) && lastSessions.get(s.id)?.updated !== s.updated)
          pending.push({
            key: 'session/' + s.id + '/' + s.updated,
            source: owner.id,
            location: s.cwd,
            sessionId: s.id,
            lane: 'session',
            at: s.updated,
            origin: 'Codex 元数据',
            title: '会话索引更新 · ' + s.id,
          });
        return [
          { ...s, owner: owner.id, verified: available && currentIds.has(s.id) && !owner.missing },
        ];
      });
    const conflicts = {},
      verifiedDeployments = {};
    const recorded = new Map([...this.events].filter(([, e]) => e.lane === 'receipt'));
    for (const p of this.config.projects) {
      const matched = sessions.filter(
        (s) => s.verified && p.members.includes(s.owner) && !p.ignored.includes(s.id),
      );
      const receipts = await readReceipts(p, rows, roots, matched, recorded);
      conflicts[p.id] = receipts.issues;
      verifiedDeployments[p.id] = receipts.events
        .filter((e) => e.result === 'deployed')
        .map((e) => e.key);
      pending.push(...receipts.events);
    }
    const snapshot = {
      rows,
      sessions,
      issues,
      conflicts,
      verifiedDeployments,
      codex: { status: meta.status, reason: meta.reason },
      scanned: Date.now(),
      reason,
    };
    const all = [...new Map([...this.events, ...pending.map((e) => [e.key, e])]).values()];
    for (const p of this.config.projects) {
      const history = this.history(p, snapshot, all);
      const state = this.phase(p, history);
      const flags = this.indicators(p, snapshot, history);
      const previous = history.find((e) => e.lane === 'state' && e.milestoneId === p.milestoneId);
      const summary = [state, ...flags].join(' · ');
      if (previous?.title !== summary)
        pending.push({
          key: 'state/' + randomUUID(),
          source: p.id,
          milestoneId: p.milestoneId,
          lane: 'state',
          at: snapshot.scanned,
          origin: '证据汇总',
          title: summary,
          detail: previous ? '上次 · ' + previous.title : '首次确认阶段',
        });
    }
    this.commit('snapshot', snapshot, pending);
  }
  history(p, snap = this.snapshot, all = [...this.events.values()]) {
    const visible = new Set(snap.sessions.filter((s) => !p.ignored?.includes(s.id)).map((s) => s.id));
    return all
      .filter((e) => {
        if (e.source !== p.id && !p.members.includes(e.source)) return false;
        if (e.location && !rootFor(e.location, this.config.roots)) return false;
        if (e.lane === 'session' && !visible.has(e.sessionId)) return false;
        return true;
      })
      .sort(byTime);
  }
  phase(p, history) {
    const receipts = history.filter((e) => e.lane === 'receipt' && e.milestoneId === p.milestoneId);
    if (receipts.some((e) => e.result === p.gate)) return '已交付';
    if (receipts.some((e) => ['ready', 'accepted', 'deployed'].includes(e.result))) return '待验收';
    if (
      receipts.some((e) => ['progress', 'tests_passed'].includes(e.result)) ||
      history.some((e) => e.change && e.at >= p.started)
    )
      return '进行中';
    return '待开始';
  }
  indicators(p, snap, history) {
    const flags = [];
    const receipts = history.filter((e) => e.lane === 'receipt' && e.milestoneId === p.milestoneId);
    if (receipts.find((e) => ['blocked', 'resolved'].includes(e.result))?.result === 'blocked')
      flags.push('阻塞');
    if (receipts.find((e) => ['decision', 'resolved'].includes(e.result))?.result === 'decision')
      flags.push('待我决定');
    if (snap.conflicts[p.id]?.length) flags.push('证据冲突');
    const dirs = snap.rows.filter((r) => p.members.includes(r.id));
    if (
      !p.members.every((id) => dirs.some((r) => r.id === id)) ||
      dirs.some((r) => r.missing || r.error) ||
      ((!snap.codex || snap.codex.status !== '已接通') &&
        dirs.some((r) => rootFor(r.path, this.config.roots)?.sessions))
    )
      flags.push('数据过期');
    return flags;
  }
  items() {
    const { rows, sessions } = this.snapshot;
    const owners = new Set(this.config.projects.flatMap((p) => p.members));
    const sets = Map.groupBy(rows, (r) => r.id);
    const all = [...this.events.values()];
    const build = (p, candidate) => {
      const locations = p.members
        .flatMap((id) => sets.get(id) || [])
        .filter((r) => rootFor(r.path, this.config.roots))
        .sort(
          (a, b) =>
            Number(b.common === path.join(b.path, '.git')) -
              Number(a.common === path.join(a.path, '.git')) || a.path.localeCompare(b.path),
        );
      const s = sessions.filter(
        (s) => p.members.includes(s.owner) && rootFor(s.cwd, this.config.roots)?.sessions,
      );
      const linked = s.filter((s) => !p.ignored.includes(s.id));
      const history = this.history(p, this.snapshot, all);
      const receipts = history.filter((e) => e.lane === 'receipt' && e.milestoneId === p.milestoneId);
      const latestDeployment = receipts.find((e) => e.result === 'deployed');
      const latest =
        history.find((e) => ['files', 'git', 'receipt', 'baseline'].includes(e.lane)) || null;
      const stage = candidate ? '待确认' : this.phase(p, history);
      const flags = candidate
        ? locations.some((r) => r.error)
          ? ['数据过期']
          : []
        : this.indicators(p, this.snapshot, history);
      if (
        this.snapshot.scanned &&
        Date.now() - this.snapshot.scanned > 180000 &&
        !flags.includes('数据过期')
      )
        flags.push('数据过期');
      const attention =
        flags.includes('待我决定') ||
        (p.notify.includes('blocked') && flags.includes('阻塞')) ||
        (p.notify.includes('review') && stage === '待验收') ||
        (p.notify.includes('conflict') && flags.includes('证据冲突'));
      const group = candidate
        ? '新发现待确认'
        : attention
          ? '需要我处理'
          : latest && latest.at >= Date.now() - 7 * 86400000
            ? '最近有变化'
            : '其他';
      return {
        ...p,
        candidate,
        group,
        stage,
        flags,
        locations: locations.map(publicRow),
        sessions: linked,
        availableSessions: s,
        sessionAccess: locations.some((r) => rootFor(r.path, this.config.roots)?.sessions),
        latest,
        updated: Math.max(
          latest?.at || 0,
          history.find((e) => ['setup', 'state'].includes(e.lane))?.at || 0,
          candidate ? locations[0]?.found || 0 : p.started,
        ),
        next:
          receipts[0]?.next ||
          p.initialNext ||
          (candidate ? '核对归组与交付规则' : '按已确认的里程碑推进'),
        deployment: latestDeployment
          ? this.snapshot.verifiedDeployments?.[p.id]?.includes(latestDeployment.key)
            ? '已上线'
            : '上次上线已核实，当前待复核'
          : '上线未核实',
        issues: this.snapshot.conflicts[p.id] || [],
        history,
      };
    };
    const projects = this.config.projects.map((p) => build(p, false));
    for (const [id, group] of sets) {
      if (owners.has(id)) continue;
      const row = group.find((r) => r.common === path.join(r.path, '.git')) || group[0];
      const root = rootFor(row.path, this.config.roots);
      if (!root) continue;
      projects.push(
        build(
          {
            id,
            name: path.basename(row.path) || row.path,
            category: root.category,
            goal: '待确认里程碑',
            members: [id],
            ignored: [],
            notify: [],
            required: [],
          },
          true,
        ),
      );
    }
    return projects;
  }
  view() {
    const items = this.items().map(({ history, ...item }) => item);
    return {
      items,
      revision: this.config.revision,
      roots: this.config.roots,
      chatDirs: this.config.chatDirs || [],
      scanned: this.snapshot.scanned,
      reason: this.snapshot.reason,
      codex: this.snapshot.codex,
      issues: this.snapshot.issues,
      sequence: this.sequence,
    };
  }
}
