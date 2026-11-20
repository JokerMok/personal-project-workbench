import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as wait } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './test/fixture.mjs';

const run = promisify(execFile);
const slim = { headers: { 'content-type': 'application/json', 'x-workbench-request': '1' } };
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function until(read, accept, timeout = 11000) {
  const start = Date.now();
  let last;
  do {
    last = await read();
    if (accept(last)) return last;
    await wait(100);
  } while (Date.now() - start < timeout);
  throw Error('未观察到预期变化 · ' + JSON.stringify(last).slice(0, 450));
}
test('独立采集、证据边界与重启', async (t) => {
  const f = await fixture(),
    port = await freePort(),
    url = 'http://127.0.0.1:' + port,
    here = import.meta.dirname;
  const audit = path.join(f.base, 'read-audit.txt');
  const env = {
    ...process.env,
    WORKBENCH_PORT: String(port),
    WORKBENCH_DATA: f.data,
    WORKBENCH_CODEX_HOME: f.codex,
    WORKBENCH_TEST_AUDIT: audit,
    WORKBENCH_CODEX_BIN: '/not-a-real-codex-bin',
    WORKBENCH_TEST_OUTSIDE: f.outside,
    NODE_OPTIONS: '--import=' + new URL('./test/read-guard.mjs', import.meta.url).href,
  };
  const cmd = (file, args) => run(process.execPath, [path.join(here, file), ...args], { env });
  const control = (action) => cmd('control.mjs', [action]);
  const get = async (route) => (await fetch(url + route)).json();
  const state = () => get('/api/state');
  const post = async (route, body) => {
    const res = await fetch(url + route, { ...slim, method: 'POST', body: JSON.stringify(body) });
    const data = await res.json();
    assert.equal(res.status, 200, data.error);
    return data;
  };
  const rootData = [
    { path: f.personal, category: '个人', sessions: true },
    { path: f.work, category: '工作', sessions: true },
  ];
  const changed = async (route) => until(state, (s) => route(s.items));
  const current = async (id) => (await state()).items.find((p) => p.id === id);
  const rule = {
    goal: '交付联调结果',
    category: '个人',
    gate: 'deployed',
    criteria: '核对校验记录',
    initialNext: '完成联调',
    notify: ['blocked', 'review', 'conflict'],
    ignored: [],
    required: ['验收记录.md'],
  };
  let git, doc, receipt, proof;
  await control('start');
  try {
    const indexStat = await fs.stat(path.join(f.api, '.git/index'));
    await t.test('会话授权和项目扫描独立，越界请求不会进入 Codex', async () => {
      const empty = await state();
      const scoped = await post('/api/codex/scopes', {
        revision: empty.revision,
        dirs: [{ path: f.api, exact: true }],
      });
      assert.deepEqual(scoped.state.roots, []);
      assert.deepEqual(scoped.state.items, []);
      const list = await get('/api/codex/sessions');
      assert.deepEqual(
        list.sessions.map((session) => session.id),
        ['synthetic-api-01'],
      );
      assert.doesNotMatch(JSON.stringify(list), /BODY_CANARY|rollout_path|outside-never|escaped-never/);
      const raw = await fetch(url + '/api/codex/thread/synthetic-api-01');
      assert.equal(raw.status, 403);
      const hidden = await fetch(url + '/api/codex/thread/outside-never', slim);
      assert.equal(hidden.status, 400);
      assert.match((await hidden.json()).error, /授权范围/);
      const fork = await fetch(url + '/api/codex/fork', {
        ...slim,
        method: 'POST',
        body: JSON.stringify({ threadId: 'outside-never' }),
      });
      assert.equal(fork.status, 400);
      assert.match((await fork.json()).error, /授权范围/);
      const escaped = await fetch(url + '/api/codex/send', {
        ...slim,
        method: 'POST',
        body: JSON.stringify({
          cwd: path.join(f.api, '外部链接'),
          message: '测试消息',
          requestId: randomUUID(),
        }),
      });
      assert.equal(escaped.status, 400);
      assert.match((await escaped.json()).error, /授权/);
    });
    await t.test('空首页、路径授权、worktree 和只读会话投影', async () => {
      const empty = await state();
      assert.deepEqual(empty.items, []);
      assert.deepEqual(empty.roots, []);
      const { state: s } = await post('/api/roots', { revision: empty.revision, roots: rootData });
      assert.equal(s.codex.status, '已接通');
      assert.equal(s.items.length, 3);
      assert.equal(s.items.filter((p) => p.group === '新发现待确认').length, 3);
      const api = s.items.find((p) => p.name === '接口仓库'),
        web = s.items.find((p) => p.name === '网页仓库'),
        notes = s.items.find((p) => p.name === '手册修订');
      assert.equal(api.locations.length, 2);
      assert.equal(api.locations[0].git.subject, '建立接口骨架');
      assert.deepEqual(
        api.sessions.map((s) => s.id),
        ['synthetic-api-01'],
      );
      assert.doesNotMatch(JSON.stringify(s), /BODY_CANARY|outside-never|escaped-never|rollout_path/);
      const one = await post('/api/projects', {
        ...rule,
        revision: s.revision,
        name: '松石工具',
        members: [api.id, web.id],
      });
      const two = await post('/api/projects', {
        ...rule,
        revision: one.state.revision,
        name: '手册修订',
        category: '工作',
        goal: '交付定稿手册',
        gate: 'accepted',
        members: [notes.id],
      });
      git = await current(one.id);
      doc = await current(two.id);
      assert.equal(git.stage, '待开始');
      assert.equal(git.locations.length, 3);
      assert.equal(doc.locations[0].kind, 'directory');
      assert.equal((await fs.stat(path.join(f.api, '.git/index'))).mtimeMs, indexStat.mtimeMs);
    });
    await t.test('仅更新会话或日志时，里程碑与阶段保持原值', async () => {
      const db = new DatabaseSync(path.join(f.codex, 'state_5.sqlite'));
      const fresh = Math.floor(Date.now() / 1000);
      db.prepare("UPDATE threads SET updated_at=? WHERE id='synthetic-api-01'").run(fresh);
      db.close();
      const now = new Date();
      await fs.utimes(path.join(f.api, 'README.md'), now, now);
      await fs.writeFile(path.join(f.api, '运行.log'), 'heartbeat\n');
      await changed(
        (items) => items.find((p) => p.id === git.id)?.sessions[0]?.updated === fresh * 1000,
      );
      const item = await current(git.id);
      assert.equal(item.stage, '待开始');
      assert.equal(item.latest.lane, 'git');
    });
    const submit = async (p, result, file, next) =>
      cmd('receipt.mjs', [
        '--project',
        p.id,
        '--milestone',
        p.milestoneId,
        '--version',
        'v1',
        '--result',
        result,
        '--proof',
        file,
        '--next',
        next,
      ]);
    await t.test('阻塞与决定标记可独立于待开始阶段', async () => {
      const existing = path.join(f.api, 'README.md');
      await submit(git, 'blocked', existing, '等接口确认');
      await changed((items) => items.find((p) => p.id === git.id)?.flags.includes('阻塞'));
      await submit(git, 'decision', existing, '选择接口版本');
      await changed((items) => items.find((p) => p.id === git.id)?.flags.includes('待我决定'));
      assert.equal((await current(git.id)).stage, '待开始');
      await submit(git, 'resolved', existing, '开始联调');
      await changed((items) => !items.find((p) => p.id === git.id)?.flags.length);
      assert.equal((await current(git.id)).stage, '待开始');
    });
    await t.test('没有页面的实际文件监听、Git 提交和非 Git 变化均独立于交付', async () => {
      await fs.appendFile(path.join(f.api, 'README.md'), '联调稿\n');
      await fs.writeFile(path.join(f.doc, '手册.md'), '验收用二稿\n');
      await changed((items) => items.length === 2 && items.every((p) => p.stage === '进行中'));
      assert.equal((await current(git.id)).deployment, '上线未核实');
      assert.equal((await current(doc.id)).latest.title, '修改 手册.md');
      await run(
        '/usr/bin/git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          '-c',
          'core.hooksPath=/dev/null',
          '-C',
          f.api,
          'commit',
          '-am',
          '更新接口约定',
        ],
        { env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } },
      );
      await until(
        () => get('/api/detail/' + git.id),
        (p) => p.history.some((e) => e.lane === 'git' && e.title === '更新接口约定'),
      );
      assert.equal((await current(git.id)).stage, '进行中');
    });

    await t.test('项目回执、交付门槛和上次可信记录', async () => {
      proof = path.join(f.api, '验收记录.md');
      const docProof = path.join(f.doc, '验收记录.md');
      await fs.writeFile(proof, '合成联调记录');
      await fs.writeFile(docProof, '合成校对记录');
      await submit(git, 'tests_passed', proof, '准备验收');
      await changed((items) => items.find((p) => p.id === git.id)?.next === '准备验收');
      assert.equal((await current(git.id)).stage, '进行中');
      await submit(git, 'ready', proof, '请核对联调');
      await changed((items) => items.find((p) => p.id === git.id)?.group === '需要我处理');
      await submit(git, 'accepted', proof, '等待部署回执');
      await changed((items) => items.find((p) => p.id === git.id)?.next === '等待部署回执');
      assert.equal((await current(git.id)).stage, '待验收');
      assert.equal((await current(git.id)).deployment, '上线未核实');
      const record = await submit(doc, 'accepted', docProof, '归档手册');
      receipt = record.stdout.trim();
      const retried = await submit(doc, 'accepted', docProof, '归档手册');
      assert.equal(retried.stdout.trim(), receipt);
      await changed((items) => items.find((p) => p.id === doc.id)?.stage === '已交付');
      assert.equal((await current(doc.id)).deployment, '上线未核实');
      await fs.appendFile(docProof, '后续变更');
      await changed((items) => items.find((p) => p.id === doc.id)?.flags.includes('证据冲突'));
      assert.equal((await current(doc.id)).stage, '已交付');
      await fs.writeFile(docProof, '合成校对记录');
      await changed((items) => !items.find((p) => p.id === doc.id)?.flags.includes('证据冲突'));
      const other = path.join(f.api, '其他记录.md');
      await fs.writeFile(other, '合成记录');
      await assert.rejects(submit(git, 'deployed', other, '缺少约定证据'), /缺少已约定/);
      const invalid = JSON.parse(await fs.readFile(receipt, 'utf8'));
      Object.assign(invalid, {
        id: 'bad-rule',
        projectId: git.id,
        milestoneId: git.milestoneId,
        result: 'deployed',
        at: new Date().toISOString(),
      });
      invalid.evidence = [
        {
          path: other,
          sha256: (await import('node:crypto'))
            .createHash('sha256')
            .update(await fs.readFile(other))
            .digest('hex'),
        },
      ];
      const badFile = path.join(f.data, 'receipts', git.id, 'bad-rule.json');
      await fs.writeFile(badFile, JSON.stringify(invalid));
      await changed((items) =>
        items.find((p) => p.id === git.id)?.issues.some((issue) => issue.startsWith('bad-rule.json')),
      );
      assert.equal((await current(git.id)).deployment, '上线未核实');
      await fs.unlink(badFile);
      await submit(git, 'deployed', proof, '核对上线版本');
      await changed((items) => items.find((p) => p.id === git.id)?.stage === '已交付');
      assert.equal((await current(git.id)).deployment, '已上线');
    });
    await t.test('数据缺失标记、重启留存与未注册操作接口', async () => {
      await fs.rename(f.doc, f.doc + '-离线');
      await changed((items) => items.find((p) => p.id === doc.id)?.flags.includes('数据过期'));
      assert.equal((await current(doc.id)).goal, '交付定稿手册');
      await fs.rename(f.doc + '-离线', f.doc);
      await changed((items) => !items.find((p) => p.id === doc.id)?.flags.includes('数据过期'));
      const prev = (await get('/api/detail/' + doc.id)).history.filter(
        (e) => e.lane === 'receipt',
      ).length;
      await control('restart');
      await until(state, (s) => s.reason === '启动扫描' && s.sequence > 0);
      const after = await get('/api/detail/' + doc.id);
      assert.equal(after.stage, '已交付');
      assert.equal(after.next, '归档手册');
      assert.equal(after.history.filter((e) => e.lane === 'receipt').length, prev);
      assert.equal(JSON.parse(await fs.readFile(receipt, 'utf8')).evidence[0].sha256.length, 64);
      for (const route of [
        '/api/projects/' + git.id + '/git/commit',
        '/api/projects/' + git.id + '/terminal/run',
        '/api/docker/containers/stop',
        '/api/agent/runs',
        '/api/agent-sessions/codex/synthetic-api-01/resume',
        '/api/app/update',
        '/mcp',
      ]) {
        const response = await fetch(url + route, { ...slim, method: 'POST', body: '{}' });
        assert.equal(response.status, 404, route);
      }
      const auditLog = await fs.readFile(audit, 'utf8');
      assert.match(auditLog, /allowed metadata/);
      assert.doesNotMatch(auditLog, /DENIED/);
    });
  } finally {
    await control('stop');
    await fs.rm(f.base, { recursive: true, force: true });
  }
});
