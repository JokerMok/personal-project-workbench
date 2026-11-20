import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

export async function fixture() {
  const base = await fs.mkdtemp('/private/tmp/project-desk-');
  const personal = path.join(base, '个人项目'),
    work = path.join(base, '工作项目'),
    family = path.join(personal, '松石工具');
  const api = path.join(family, '接口仓库'),
    web = path.join(family, '网页仓库'),
    tree = path.join(personal, '接口实验分支');
  const doc = path.join(work, '手册修订'),
    outside = personal + '-未授权',
    codex = path.join(base, '合成索引'),
    data = path.join(base, '工作台数据');
  for (const dir of [api, web, doc, outside, path.join(codex, 'sessions')])
    await fs.mkdir(dir, { recursive: true });
  const git = (dir, ...args) =>
    execFileSync(
      '/usr/bin/git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'core.hooksPath=/dev/null',
        '-C',
        dir,
        ...args,
      ],
      {
        stdio: 'pipe',
        env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      },
    );
  for (const dir of [api, web]) {
    git(dir, 'init', '-b', 'main');
    await fs.writeFile(path.join(dir, 'README.md'), '合成验收项目\n');
    git(dir, 'add', 'README.md');
    git(dir, 'commit', '-m', dir === api ? '建立接口骨架' : '加入项目首页');
  }
  git(api, 'worktree', 'add', '-b', 'trial', tree);
  await fs.writeFile(path.join(doc, '手册.md'), '验收用初稿\n');
  await fs.symlink(outside, path.join(api, '外部链接'));
  const body = path.join(codex, 'sessions', 'forbidden.jsonl');
  await fs.writeFile(body, '{"prompt":"BODY_CANARY_PRIVATE","response":"SHOULD_NEVER_BE_READ"}\n');
  const db = new DatabaseSync(path.join(codex, 'state_5.sqlite'));
  db.exec(
    'CREATE TABLE threads(id TEXT PRIMARY KEY,cwd TEXT,created_at INTEGER,updated_at INTEGER,first_user_message TEXT,rollout_path TEXT)',
  );
  const insert = db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?)'),
    sec = Math.floor(Date.now() / 1000) - 30;
  for (const [id, cwd] of [
    ['synthetic-api-01', api],
    ['synthetic-doc-02', doc],
    ['outside-never', outside],
    ['escaped-never', path.join(api, '外部链接')],
  ]) {
    insert.run(id, cwd, sec - 100, sec, 'SQL_BODY_CANARY_PRIVATE', body);
  }
  db.close();
  return { base, personal, work, api, web, tree, doc, outside, codex, data, body };
}
