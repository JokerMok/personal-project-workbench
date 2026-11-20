import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { dataDir, port } from './paths.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)),
  runtime = path.join(dataDir, 'service.json');
const url = 'http://127.0.0.1:' + port;
async function identity() {
  try {
    const info = JSON.parse(fs.readFileSync(runtime, 'utf8'));
    const live = await (
      await fetch('http://127.0.0.1:' + info.port + '/api/health', {
        signal: AbortSignal.timeout(1000),
        redirect: 'error',
      })
    ).json();
    if (
      live.app === 'personal-project-workbench' &&
      info.pid === live.pid &&
      info.instance === live.instance
    )
      return info;
  } catch {}
}
async function start() {
  const live = await identity();
  if (live) {
    console.log('服务运行中 · http://127.0.0.1:' + live.port);
    return;
  }
  if (!fs.existsSync(path.join(here, 'dist/app.js'))) throw Error('请先运行 npm ci 和 npm run build');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const log = path.join(dataDir, 'service.log');
  if (fs.existsSync(log) && fs.statSync(log).size > 256 * 1024) fs.renameSync(log, log + '.previous');
  const fd = fs.openSync(log, 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [path.join(here, 'server.mjs')], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: process.env,
    });
  } finally {
    fs.closeSync(fd);
  }
  child.unref();
  for (let i = 0; i < 80; i++) {
    await wait(100);
    if (await identity()) {
      console.log('服务已启动 · ' + url);
      return;
    }
    if (child.exitCode !== null) break;
  }
  throw Error('服务启动失败，请查看 ' + log);
}
async function stop() {
  const info = await identity();
  if (!info) {
    if (fs.existsSync(runtime)) {
      const old = JSON.parse(fs.readFileSync(runtime, 'utf8'));
      if (!Number.isSafeInteger(old.pid) || old.pid < 2) throw Error('请核对运行记录 ' + runtime);
      try {
        process.kill(old.pid, 0);
        throw Error('运行记录与服务响应不匹配，请核对 ' + runtime);
      } catch (e) {
        if (e.code !== 'ESRCH') throw e;
      }
    }
    console.log('服务已停止');
    return;
  }
  process.kill(info.pid, 'SIGTERM');
  for (let i = 0; i < 300; i++) {
    await wait(100);
    if (!fs.existsSync(runtime)) {
      console.log('服务已停止');
      return;
    }
  }
  throw Error('服务正在结束本次采集，请稍后检查状态');
}
try {
  const action = process.argv[2] || 'start';
  if (action === 'start') await start();
  else if (action === 'stop') await stop();
  else if (action === 'restart') {
    await stop();
    await start();
  } else if (action === 'status') {
    const live = await identity();
    console.log(live ? '运行中 · http://127.0.0.1:' + live.port : '已停止');
  } else throw Error('可用命令 start / stop / restart / status');
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
