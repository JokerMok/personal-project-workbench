import path from 'node:path';
import os from 'node:os';
import { promises as fs, constants } from 'node:fs';
import { createHash } from 'node:crypto';

export const dataDir = systemPath(
  process.env.WORKBENCH_DATA || path.join(os.homedir(), 'Library/Application Support/个人项目工作台'),
);
export const codexDir = systemPath(
  process.env.WORKBENCH_CODEX_HOME || path.join(os.homedir(), '.codex'),
);
export const receiptsDir = path.join(dataDir, 'receipts');
export const port = Number(process.env.WORKBENCH_PORT || 43127);
export const idFor = (type, value) =>
  type + '-' + createHash('sha256').update(value).digest('hex').slice(0, 20);
export const inside = (root, value) =>
  value === root || value.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
export const protectedPath = (value) =>
  [dataDir, codexDir, path.join(os.homedir(), '.codex')].some((dir) => inside(dir, value));
export const rootFor = (value, roots) =>
  roots.filter((root) => inside(root.path, value)).sort((a, b) => b.path.length - a.path.length)[0];

export function systemPath(value) {
  const resolved = path.resolve(value);
  // Darwin exposes the same system directories under two spellings.
  return process.platform === 'darwin'
    ? resolved.replace(/^\/(tmp|var|etc)(?=\/|$)/, '/private/$1')
    : resolved;
}

export async function canonicalRoot(value) {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    value.split('/').includes('..') ||
    value.includes('\0')
  )
    throw Error('请输入现有目录的绝对路径');
  const expected = systemPath(value);
  const actual = await fs.realpath(expected).catch(() => '');
  if (
    actual !== expected ||
    protectedPath(actual) ||
    actual.split('/').some((s) => ['.git', '.codex', '.ssh'].includes(s)) ||
    !(await fs.stat(actual)).isDirectory()
  )
    throw Error('目录不可用，或路径经过符号链接。请选择实际项目目录');
  return actual;
}

// Check the directory grant again on every read, including after a drive remount or a rename.
export async function allowedPath(value, roots) {
  if (!path.isAbsolute(value) || value.split('/').includes('..')) return false;
  const target = systemPath(value);
  return (
    !protectedPath(target) &&
    !!rootFor(target, roots) &&
    (await fs.realpath(target).catch(() => '')) === target
  );
}

async function verifiedHandle(file, handle) {
  const opened = await handle.stat({ bigint: true });
  const current = await fs.lstat(file, { bigint: true });
  if (
    !opened.isFile() ||
    opened.dev !== current.dev ||
    opened.ino !== current.ino ||
    (await fs.realpath(file)) !== file
  ) {
    throw Error('文件路径已变更或未经授权');
  }
  return opened;
}

export async function readSmall(file, limit = 65536) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await verifiedHandle(file, handle);
    if (!stat.isFile() || stat.size > limit) throw Error('文件类型或大小不符合约定');
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw Error('文件过大');
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function digestFile(file, cache) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await verifiedHandle(file, handle);
    if (!st.isFile()) throw Error('证据必须是普通文件');
    const key = [st.dev, st.ino, st.size, st.mtimeNs, st.ctimeNs].join('/');
    if (cache?.get(file)?.key === key) return cache.get(file).digest;
    const hash = createHash('sha256');
    for await (const part of handle.createReadStream({ autoClose: false })) hash.update(part);
    const after = await handle.stat({ bigint: true });
    if (st.ctimeNs !== after.ctimeNs || st.size !== after.size) throw Error('证据文件正在变化');
    const digest = hash.digest('hex');
    cache?.set(file, { key, digest });
    return digest;
  } finally {
    await handle.close();
  }
}
