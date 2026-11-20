import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { dataDir, port, receiptsDir, inside, digestFile, readSmall } from './paths.mjs';
import { results, validateProof, verifyRequired } from './receipts.mjs';

export async function writeReceipt(options) {
  const url = 'http://127.0.0.1:' + port;
  const state = await (await fetch(url + '/api/state', { redirect: 'error' })).json();
  const project = state.items.find((p) => p.id === options.project && !p.candidate);
  if (!project || project.milestoneId !== options.milestone) throw Error('项目或当前里程碑编号不匹配');
  if (
    !Object.hasOwn(results, options.result) ||
    !(options.version || options.session) ||
    !options.next?.trim() ||
    !options.proof?.length
  )
    throw Error('请提供结果、会话或版本、下一步和证据文件');
  if (options.session && !project.sessions.some((s) => s.id === options.session && s.verified))
    throw Error('会话归属未核实');
  const locations = state.items.flatMap((p) => p.locations);
  if ([options.next, options.version].some((v) => v && v.length > 500) || options.proof.length > 32)
    throw Error('回执字段超长');
  const evidence = [],
    matched = new Set();
  for (const file of options.proof) {
    const full = path.resolve(file);
    matched.add(await validateProof(full, project, locations, state.roots));
    evidence.push({ path: full, sha256: await digestFile(full) });
  }
  verifyRequired(project, options.result, matched);
  evidence.sort((a, b) => a.path.localeCompare(b.path));
  const record = {
    projectId: project.id,
    milestoneId: project.milestoneId,
    version: options.version || undefined,
    sessionId: options.session || undefined,
    result: options.result,
    evidence,
    next: options.next,
  };
  const id = createHash('sha256').update(JSON.stringify(record)).digest('hex');
  const payload = { schemaVersion: 1, id, at: new Date().toISOString(), ...record };
  const folder = path.join(receiptsDir, project.id);
  if (!inside(dataDir, folder) || (await fs.realpath(folder)) !== folder) throw Error('回执目录无效');
  const tmp = path.join(folder, randomUUID() + '.tmp'),
    dest = path.join(folder, id + '.json');
  try {
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    try {
      await fs.link(tmp, dest);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const existing = JSON.parse(await readSmall(dest));
      if (
        existing.id !== id ||
        existing.schemaVersion !== 1 ||
        Object.entries(record).some(([k, v]) => JSON.stringify(existing[k]) !== JSON.stringify(v))
      )
        throw Error('已有同编号回执与本次内容冲突');
    }
  } finally {
    await fs.rm(tmp, { force: true });
  }
  return dest;
}
if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  try {
    const { values } = parseArgs({
      options: {
        project: { type: 'string' },
        milestone: { type: 'string' },
        version: { type: 'string' },
        session: { type: 'string' },
        result: { type: 'string' },
        proof: { type: 'string', multiple: true },
        next: { type: 'string' },
      },
    });
    console.log(await writeReceipt(values));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
