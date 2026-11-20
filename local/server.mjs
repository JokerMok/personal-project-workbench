import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs, watch } from 'node:fs';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Board } from './board.mjs';
import { Chat } from './chat.mjs';
import { CodexProjects } from './projects.mjs';
import { ProjectReviews } from './reviews.mjs';
import { codexDir, dataDir, port, protectedPath, receiptsDir, allowedPath } from './paths.mjs';
import { openNativeFolderPicker } from '../apps/server/src/folderPicker.ts';
import { isAllowedRequestHost } from '../apps/server/src/lib/requestHost.ts';
import { ignoredDir } from '../apps/server/src/gitScanner.ts';

process.umask(0o077);
const here = path.dirname(fileURLToPath(import.meta.url));
const staticFiles = new Map([
  ['/', [path.join(here, 'web/index.html'), 'text/html; charset=utf-8']],
  ['/app.js', [path.join(here, 'dist/app.js'), 'text/javascript; charset=utf-8']],
  ['/style.css', [path.join(here, 'web/style.css'), 'text/css; charset=utf-8']],
  ['/mark.svg', [path.join(here, '../apps/web/public/icon/repo-control-mark.svg'), 'image/svg+xml']],
]);
await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
const runtime = path.join(dataDir, 'service.json');
const identity = { pid: process.pid, port, instance: randomUUID() };
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== 'ESRCH';
  }
};
async function claimService() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.writeFile(runtime, JSON.stringify(identity), { flag: 'wx', mode: 0o600 });
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const old = JSON.parse(await fs.readFile(runtime, 'utf8'));
      if (!Number.isSafeInteger(old.pid) || old.pid < 2 || alive(old.pid))
        throw Error('此数据目录已有服务，或运行记录需核对');
      await fs.unlink(runtime);
    }
  }
  throw Error('服务正在启动');
}
await claimService();
const board = await Board.open();
const chat = new Chat(board);
const catalog = new CodexProjects(board, chat);
let projectVersion = 0;
function projectsChanged() {
  projectVersion++;
  broadcast();
}
const reviews = new ProjectReviews(board, catalog, chat, projectsChanged);
const clients = new Set(),
  watches = [];
let queue = Promise.resolve(),
  timer,
  firstDirty = 0,
  scanQueued = false,
  rerun = false,
  closing = false,
  lastFailure = '';
const serialize = (run) => {
  const task = queue.then(run);
  queue = task.catch(() => {});
  return task;
};
function broadcast() {
  for (const client of clients) client.write('data: ' + board.sequence + '\n\n');
}
async function scan(reason) {
  try {
    await board.scan(reason);
    lastFailure = '';
  } catch {
    lastFailure = '本次采集未完成，保留上次结果';
  }
  projectsChanged();
}
function schedule(reason, delay = 500) {
  if (closing) return;
  firstDirty ||= Date.now();
  clearTimeout(timer);
  timer = setTimeout(
    () => {
      firstDirty = 0;
      if (scanQueued) {
        rerun = true;
        return;
      }
      scanQueued = true;
      serialize(async () => {
        try {
          await scan(reason);
        } finally {
          scanQueued = false;
          if (rerun) {
            rerun = false;
            schedule('变化补扫', 100);
          }
        }
      });
    },
    Math.max(0, Math.min(delay, 2500 - (Date.now() - firstDirty))),
  );
}
function watchDir(dir, recursive, onChange) {
  try {
    const handle = watch(dir, { recursive }, (_, name) => onChange(String(name || '')));
    handle.on('error', () => {
      handle.close();
      schedule('监听恢复');
    });
    watches.push(handle);
  } catch {
    /* The periodic scan also covers briefly unmounted volumes. */
  }
}
async function resetWatchers() {
  for (const handle of watches.splice(0)) handle.close();
  const roots = board.config.roots;
  for (const root of roots) {
    if (!(await allowedPath(root.path, roots))) continue;
    watchDir(root.path, true, (name) => {
      if (protectedPath(path.join(root.path, name))) return;
      const parts = name.split(path.sep);
      const git = parts.indexOf('.git');
      if (git >= 0) {
        if (
          !['HEAD', 'packed-refs', 'refs', 'worktrees', 'commondir'].includes(parts[git + 1]) &&
          parts.length !== git + 1
        )
          return;
      } else if (parts.some(ignoredDir) || /\.(log|jsonl|tmp)$/.test(name)) return;
      schedule('目录变化');
    });
  }
  watchDir(receiptsDir, true, (name) => {
    if (!name || name.endsWith('.json')) schedule('交付回执');
  });
  if (
    (roots.some((r) => r.sessions) || board.config.chatDirs?.length) &&
    (await fs.realpath(codexDir).catch(() => '')) === codexDir
  )
    watchDir(codexDir, false, (name) => {
      if (/^state_\d+\.sqlite(?:-wal)?$/.test(name)) {
        catalog.invalidate();
        schedule('会话索引变化');
      }
    });
}
const publicState = () => ({ ...board.view(), warning: lastFailure, projectVersion });
const hostNames = new Set(['localhost', '127.0.0.1']);
function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 100000) throw Error('提交内容过大');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  try {
    const host = req.headers.host;
    const route = (req.url || '/').split('?')[0];
    if (
      !isAllowedRequestHost(host, hostNames) ||
      !['localhost:' + port, '127.0.0.1:' + port].includes(host) ||
      (req.headers.origin && req.headers.origin !== 'http://' + host) ||
      (req.headers['sec-fetch-site'] === 'cross-site' &&
        (req.method !== 'GET' || !staticFiles.has(route)))
    )
      return send(res, 403, { error: '仅接受本地同源请求' });
    if (req.method === 'GET') {
      if (route === '/api/health')
        return send(res, 200, { app: 'personal-project-workbench', ...identity });
      if (route === '/api/state') return send(res, 200, publicState());
      if (route === '/api/codex/sessions') return send(res, 200, await chat.index());
      if (route === '/api/codex/projects') {
        const list = await catalog.list();
        return send(res, 200, {
          ...list,
          items: list.items.map((item) => {
            const view = reviews.view(item.id);
            return { ...item, summary: view.report?.summary || '', reviewedAt: view.report?.at || 0 };
          }),
        });
      }
      const project = /^\/api\/codex\/projects\/([a-z\d._-]{1,128})$/i.exec(route);
      if (project) {
        if (req.headers['x-workbench-request'] !== '1')
          return send(res, 403, { error: '请从工作台打开项目' });
        const params = new URL(req.url, 'http://localhost').searchParams;
        const detail = await catalog.detail(project[1], params.get('dir'), params.get('browse') === '1');
        return send(res, 200, { ...detail, review: reviews.view(project[1]) });
      }
      const conversation = /^\/api\/codex\/(thread|turn)\/([a-z\d._-]{1,128})$/i.exec(route);
      if (conversation) {
        if (req.headers['x-workbench-request'] !== '1')
          return send(res, 403, { error: '请从工作台打开对话' });
        const [, kind, id] = conversation;
        const cursor = new URL(req.url, 'http://localhost').searchParams.get('cursor');
        return send(
          res,
          200,
          kind === 'thread' ? await chat.transcript(id, cursor) : await chat.status(id),
        );
      }
      if (/^\/api\/detail\/[a-z\d-]+$/.test(route)) {
        const item = board.items().find((p) => p.id === route.split('/').pop());
        if (!item) return send(res, 404, { error: '项目不存在' });
        return send(res, 200, {
          ...item,
          receiptDir: item.candidate ? null : path.join(receiptsDir, item.id),
          writer: path.join(here, 'receipt.mjs'),
        });
      }
      if (route === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        res.write('retry: 1200\ndata: ' + board.sequence + '\n\n');
        clients.add(res);
        res.on('close', () => clients.delete(res));
        return;
      }
      if (staticFiles.has(route)) {
        const [file, mime] = staticFiles.get(route);
        const bytes = await fs.readFile(file);
        res.writeHead(200, { 'Content-Type': mime });
        res.end(bytes);
        return;
      }
    }
    if (
      req.method === 'POST' &&
      [
        '/api/roots',
        '/api/projects',
        '/api/picker',
        '/api/codex/scopes',
        '/api/codex/send',
        '/api/codex/fork',
        '/api/codex/projects',
        '/api/codex/project-access',
        '/api/project-reviews/settings',
        '/api/project-reviews/refresh',
        '/api/codex/stop',
      ].includes(route)
    ) {
      if (
        req.headers['x-workbench-request'] !== '1' ||
        !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')
      )
        return send(res, 403, { error: '请求来源未通过校验' });
      const input = await body(req);
      if (route === '/api/codex/send') return send(res, 200, await chat.send(input));
      if (route === '/api/codex/fork') {
        const result = await chat.fork(input.threadId);
        catalog.invalidate();
        projectsChanged();
        return send(res, 200, result);
      }
      if (route === '/api/codex/projects') {
        const id = await catalog.create(input);
        projectsChanged();
        return send(res, 200, { id });
      }
      if (route === '/api/codex/project-access') {
        const cwd = await serialize(async () => {
          const cwd = await catalog.access(input);
          await resetWatchers();
          projectsChanged();
          return cwd;
        });
        return send(res, 200, { cwd });
      }
      if (route === '/api/project-reviews/settings')
        return send(res, 200, await reviews.configure(input));
      if (route === '/api/project-reviews/refresh')
        return send(res, 200, await reviews.refresh(input.projectId));
      if (route === '/api/codex/stop') return send(res, 200, await chat.interrupt(input.threadId));
      if (route === '/api/picker') {
        const picked = await openNativeFolderPicker(
          '',
          (_cwd, _program, args, timeout) =>
            new Promise((resolve) => {
              execFile('/usr/bin/osascript', args, { timeout }, (err, stdout, stderr) =>
                resolve({ ok: !err, stdout, stderr, output: stderr, exitCode: err?.code }),
              );
            }),
        );
        return send(res, 200, {
          path: picked.path || '',
          error: !picked.ok && !picked.cancelled ? '选取器未能打开，可直接粘贴目录路径' : '',
        });
      }
      const id = await serialize(async () => {
        let result;
        if (route === '/api/roots') {
          await board.setRoots(input);
          await chat.revoke();
          await resetWatchers();
        } else if (route === '/api/codex/scopes') {
          await board.setChatDirs(input);
          await chat.revoke();
          await resetWatchers();
          broadcast();
          return;
        } else result = await board.saveProject(input);
        await scan('设置更新');
        return result;
      });
      return send(res, 200, { id, state: publicState() });
    }
    return send(res, 404, { error: '此接口未注册' });
  } catch (e) {
    if (!res.headersSent)
      send(res, 400, { error: e instanceof SyntaxError ? 'JSON 格式无效' : e.message });
    else res.end();
  }
});

let previousTick = Date.now(),
  nextFallback = Date.now() + 60000;
const heartbeat = setInterval(() => {
  const now = Date.now(),
    woke = now - previousTick > 20000;
  if (woke || now >= nextFallback) {
    schedule(woke ? '唤醒补扫' : '定时补扫', 0);
    nextFallback = now + 60000;
    serialize(resetWatchers);
  }
  reviews.due().catch(() => {});
  for (const client of clients) client.write(': heartbeat\n\n');
  previousTick = now;
}, 10000);
async function stop() {
  if (closing) return;
  closing = true;
  clearTimeout(timer);
  clearInterval(heartbeat);
  reviews.closing = true;
  chat.close();
  for (const w of watches) w.close();
  for (const c of clients) c.end();
  server.close();
  server.closeAllConnections();
  await queue;
  board.db.close();
  await fs.unlink(runtime).catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
server.once('error', async (error) => {
  console.error(error.message);
  clearInterval(heartbeat);
  await fs.unlink(runtime).catch(() => {});
  process.exit(1);
});
server.listen(port, '127.0.0.1', () =>
  serialize(async () => {
    await resetWatchers();
    await scan('启动扫描');
    reviews.due().catch(() => {});
  }),
);
