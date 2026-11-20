import React, { useState } from 'react';
import { Back, Copy, go, Icon, exact } from './ui.jsx';
const lanes = {
  git: 'Git 提交',
  files: '文件变化',
  baseline: '目录基线',
  unverified: '内容未核实',
  receipt: '验收与交付',
  session: '会话活动',
  setup: '用户确认',
  state: '阶段与标记',
};
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
export function Detail({ item: p, codex }) {
  const [tab, setTab] = useState('全部');
  const history = p.history.filter(
    (e) =>
      tab === '全部' ||
      (tab === '代码与文件'
        ? ['git', 'files', 'baseline', 'unverified'].includes(e.lane)
        : tab === '状态变化'
          ? ['state', 'setup'].includes(e.lane)
          : tab === '会话活动'
            ? e.lane === 'session'
            : e.lane === 'receipt'),
  );
  const contract = p.candidate
    ? ''
    : [
        '当前项目：' + p.name + '（' + p.id + '）',
        '里程碑：' + p.goal + '（' + p.milestoneId + '）',
        '交付条件：' +
          (p.gate === 'deployed' ? '部署完成' : '验收通过') +
          '。所需验证文件：' +
          p.required.join('、') +
          '。',
        ...(p.criteria ? ['验收说明：' + p.criteria] : []),
        '完成对应验证后才产生回执。请以实际版本、证据路径和下一步替换占位符，再执行：',
        'node ' +
          quote(p.writer) +
          ' --project ' +
          quote(p.id) +
          ' --milestone ' +
          quote(p.milestoneId) +
          ' --result ' +
          p.gate +
          ' --version ' +
          quote('<实际版本>') +
          ' ' +
          p.required.map((r) => '--proof ' + quote(r)).join(' ') +
          ' --next ' +
          quote('<实际下一步>'),
        '从关联目录运行。多目录项目可使用证据的绝对路径。工作台将校验文件摘要，并自动读取本机回执。',
      ].join('\n');
  return (
    <>
      <Back />
      <div className="page-heading">
        <div>
          <div className="title-line">
            <h1>{p.name}</h1>
            <span className="badge">{p.category}</span>
          </div>
          <div className="tags">
            <span className="badge green">{p.stage}</span>
            {p.flags.map((f) => (
              <span key={f} className="badge amber">
                {f}
              </span>
            ))}
            {!p.candidate && <span className="minor">{p.deployment}</span>}
          </div>
        </div>
        <div className="detail-actions">
          {p.sessionAccess && p.locations[0] && (
            <a className="secondary" href={'#/codex/new/' + encodeURIComponent(p.locations[0].path)}>
              <Icon name="message" size={16} />与 Codex 对话
            </a>
          )}
          <button
            className={p.candidate ? 'primary' : 'secondary'}
            onClick={() => go('confirm/' + p.id)}
          >
            {p.candidate ? '确认项目归组' : '调整项目与规则'}
            <Icon name="arrow" size={15} />
          </button>
        </div>
      </div>
      {p.issues.length > 0 && (
        <div className="alert">
          <strong>证据待复核</strong>
          {p.issues.map((s) => (
            <div key={s}>{s}</div>
          ))}
        </div>
      )}
      <section className="panel facts">
        <dl>
          <div>
            <dt>当前里程碑</dt>
            <dd>{p.goal}</dd>
          </div>
          <div>
            <dt>最近实质变化</dt>
            <dd>
              {p.latest?.title || '未核实'}
              <small>
                {p.latest ? p.latest.origin + ' · ' + exact(p.latest.at) : '尚无可核实的变化记录'}
              </small>
            </dd>
          </div>
          <div>
            <dt>下一步</dt>
            <dd>{p.next}</dd>
          </div>
        </dl>
      </section>
      <section className="panel detail-section">
        <h2>
          关联目录与仓库 <span className="count">{p.locations.length}</span>
        </h2>
        {p.locations.length ? (
          p.locations.map((r) => (
            <div className="assoc" key={r.path}>
              <Icon name="folder" />
              <div>
                <div className="mono">{r.path}</div>
                <small>
                  {r.kind === 'git' ? 'Git 仓库' : '非 Git 目录'}
                  {r.git
                    ? ' · ' +
                      r.git.branch +
                      (r.git.hash ? ' · ' + r.git.hash.slice(0, 8) : ' · 暂无提交')
                    : ''}{' '}
                  · {r.count} 个文件{r.error ? ' · ' + r.error + ' · 上次核实 ' + exact(r.lastGood) : ''}
                </small>
              </div>
            </div>
          ))
        ) : (
          <p className="hint">原关联目录当前未获授权或不可用。</p>
        )}
      </section>
      <section className="panel detail-section">
        <h2>
          Codex 会话 <span className="count">{p.sessions.length}</span>
        </h2>
        {p.sessions.map((s) => (
          <div className="assoc session" key={s.id}>
            <div>
              <div className="mono">{s.id}</div>
              <small>
                {s.cwd} · 更新于 {exact(s.updated)}
                {!s.verified ? ' · 上次可信记录，当前未核实' : ''}
              </small>
            </div>
            <div className="session-actions">
              {s.verified && (
                <a className="subtle-link" href={'#/codex/' + encodeURIComponent(s.id)}>
                  打开对话
                  <Icon name="arrow" size={14} />
                </a>
              )}
              <Copy value={s.id} label="复制 ID" />
            </div>
          </div>
        ))}
        {!p.sessions.length && (
          <p className="hint">
            {!p.sessionAccess
              ? '未接通 · 此项目目录尚未授权会话元数据'
              : codex.status === '未接通'
                ? '未接通 · ' + codex.reason
                : '暂无已关联的会话元数据'}
          </p>
        )}
      </section>
      {!p.candidate && (
        <section className="panel detail-section">
          <h2>交付规则</h2>
          <p>
            {p.gate === 'deployed' ? '部署完成回执' : '验收通过回执'} · {p.required.join('、')}
          </p>
          {p.criteria && <p>{p.criteria}</p>}
          <details>
            <summary>项目级 Codex 回执约定</summary>
            <pre>{contract}</pre>
            <Copy value={contract} label="复制接入约定" />
            <p className="hint mono">{p.receiptDir}</p>
          </details>
        </section>
      )}
      <section className="panel detail-section">
        <h2>证据与状态记录</h2>
        <div className="history-tabs" role="group" aria-label="记录类型">
          {['全部', '代码与文件', '会话活动', '验收与交付', '状态变化'].map((t) => (
            <button
              className={t === tab ? 'active' : ''}
              aria-pressed={t === tab}
              key={t}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </div>
        {history.length ? (
          <ol className="timeline">
            {history.map((e) => (
              <li key={e.key}>
                <time>{exact(e.at)}</time>
                <div>
                  <span className="lane">{lanes[e.lane]}</span>
                  <strong>{e.title}</strong>
                  <small>
                    {e.origin}
                    {e.detail ? ' · ' + e.detail : ''}
                    {e.location ? ' · ' + e.location : ''}
                  </small>
                  {e.evidence && (
                    <details>
                      <summary>验证证据</summary>
                      {e.evidence.map((f) => (
                        <div key={f.path}>
                          <span className="mono">{f.path}</span>
                          <small className="mono">SHA-256 {f.sha256}</small>
                        </div>
                      ))}
                      <small>
                        回执 {e.file} · 下一步 {e.next}
                      </small>
                    </details>
                  )}
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="hint">暂无此类记录。</p>
        )}
      </section>
    </>
  );
}
