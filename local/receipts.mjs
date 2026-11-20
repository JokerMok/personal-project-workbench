import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { allowedPath, digestFile, inside, readSmall, receiptsDir } from './paths.mjs';

export const results = {
  progress: '进展',
  tests_passed: '验证通过',
  ready: '待验收',
  accepted: '验收通过',
  deployed: '部署完成',
  blocked: '阻塞',
  decision: '待我决定',
  resolved: '阻塞或决定已解决',
};
const proofCache = new Map();
export async function validateProof(file, project, rows, roots) {
  if (
    typeof file !== 'string' ||
    !path.isAbsolute(file) ||
    path.resolve(file) !== file ||
    !(await allowedPath(file, roots))
  )
    throw Error('证据不在授权目录，或路径经过符号链接');
  const owner = rows
    .filter((r) => inside(r.path, file))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (!owner || !project.members.includes(owner.id) || owner.missing || owner.error)
    throw Error('证据未归属此项目');
  const relative = path.relative(owner.path, file);
  if (
    !relative ||
    relative.split(path.sep).some((part) => part.startsWith('.')) ||
    /\.jsonl$/i.test(file)
  )
    throw Error('证据不能使用隐藏文件或会话日志');
  return relative;
}

export function verifyRequired(project, result, matched) {
  if (['accepted', 'deployed'].includes(result) && !project.required.every((name) => matched.has(name)))
    throw Error('回执缺少已约定的验收文件');
}

export async function readReceipts(project, rows, roots, sessions, recorded) {
  const folder = path.join(receiptsDir, project.id);
  const events = [],
    issues = [];
  try {
    if ((await fs.realpath(folder)) !== folder) throw Error('回执目录路径异常');
    const files = await fs.readdir(folder, { withFileTypes: true });
    for (const file of files.filter((entry) => entry.name.endsWith('.json'))) {
      try {
        if (!file.isFile() || !/^[a-zA-Z0-9_-]{1,100}\.json$/.test(file.name))
          throw Error('回执文件名或类型无效');
        const raw = await readSmall(path.join(folder, file.name));
        const r = JSON.parse(raw),
          id = file.name.slice(0, -5);
        if (r.schemaVersion !== 1 || r.id !== id || r.projectId !== project.id)
          throw Error('回执身份不匹配');
        const key = 'receipt/' + project.id + '/' + id;
        const signature = createHash('sha256').update(raw).digest('hex');
        const prior = recorded.get(key);
        if (prior && prior.signature !== signature) throw Error('已记录的回执被改写');
        if (r.milestoneId !== project.milestoneId) {
          if (prior || (project.previousMilestones || []).includes(r.milestoneId)) continue;
          throw Error('里程碑编号不匹配');
        }
        if (!Object.hasOwn(results, r.result)) throw Error('结果类型无效');
        const at = Date.parse(r.at);
        if (!Number.isFinite(at) || at < project.started || at > Date.now() + 60000)
          throw Error('回执时间与本阶段不符');
        const validText = (s) => typeof s === 'string' && s.trim().length > 0 && s.length <= 500;
        if (r.sessionId && (!validText(r.sessionId) || !sessions.some((s) => s.id === r.sessionId)))
          throw Error('会话归属未核实');
        if (r.version !== undefined && !validText(r.version)) throw Error('版本字段无效');
        if (!validText(r.version) && !r.sessionId) throw Error('缺少版本或已关联会话');
        if (
          !validText(r.next) ||
          !Array.isArray(r.evidence) ||
          !r.evidence.length ||
          r.evidence.length > 32
        )
          throw Error('缺少下一步或验证证据');
        const matched = new Set();
        for (const e of r.evidence) {
          const relative = await validateProof(e.path, project, rows, roots);
          if (!/^[a-f\d]{64}$/.test(e.sha256) || (await digestFile(e.path, proofCache)) !== e.sha256)
            throw Error('证据校验值不匹配');
          matched.add(relative);
        }
        verifyRequired(project, r.result, matched);
        events.push({
          key,
          signature,
          source: project.id,
          milestoneId: project.milestoneId,
          lane: 'receipt',
          result: r.result,
          title: results[r.result],
          origin: '交付回执 · ' + (r.version || r.sessionId),
          at,
          next: r.next,
          version: r.version || '',
          sessionId: r.sessionId || '',
          evidence: r.evidence.map((e) => ({ path: e.path, sha256: e.sha256 })),
          file: file.name,
        });
      } catch (e) {
        issues.push(file.name + ' · ' + (e instanceof SyntaxError ? 'JSON 格式无效' : e.message));
      }
    }
    const present = new Set(files.map((f) => f.name));
    for (const e of recorded.values())
      if (e.source === project.id && e.milestoneId === project.milestoneId && !present.has(e.file))
        issues.push(e.file + ' · 已记录的回执文件缺失');
  } catch {
    issues.push('回执目录未核实');
  }
  return { events, issues };
}
