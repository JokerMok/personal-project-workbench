import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';

export const reviewSignal =
  process.env.WORKBENCH_REVIEW_SIGNAL ||
  path.join(import.meta.dirname, '..', '.workbench-review-request');

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  // The scheduler writes only this timestamp. The running service reads its own authorized inputs.
  const tmp = reviewSignal + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(tmp, new Date().toISOString() + '\n', { mode: 0o600, flag: 'wx' });
    await fs.rename(tmp, reviewSignal);
  } finally {
    await fs.rm(tmp, { force: true });
  }
  console.log('已请求整理工作台内启用的项目。');
}
