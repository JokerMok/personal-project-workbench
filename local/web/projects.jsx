import React, { useEffect, useRef, useState } from 'react';
import { api, Copy, focusSection, go, Icon, exact, StatePanel } from './ui.jsx';

const endpoint = '/api/codex/projects';
const idPart = (value) => encodeURIComponent(value);
const page = (id, cwd = '') => '#/native/' + idPart(id) + (cwd ? '/' + idPart(cwd) : '');
const folderName = (cwd) => cwd.split('/').filter(Boolean).at(-1) || cwd;
const shortDate = (date) =>
  date
    ? new Intl.DateTimeFormat('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(date)
    : '—';
const numberFormat = new Intl.NumberFormat('zh-CN');
const countValue = (value, verified = true) => (verified ? numberFormat.format(value) : '—');
const day = 86_400_000;
const periods = [
  ['all', '全部时间'],
  ['7', '近 7 天'],
  ['30', '近 30 天'],
];
const current = (date, period, now) =>
  period === 'all' || (date > 0 && date >= now - Number(period) * day);

function PeriodSelect({ value, onChange, label }) {
  return (
    <select
      className="view-select"
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {periods.map(([key, text]) => (
        <option key={key} value={key}>
          {text}
        </option>
      ))}
    </select>
  );
}

function Metric({ label, value, onClick, active }) {
  const content = (
    <>
      <span className="metric-label">{label}</span>
      <strong className="metric-value">{value}</strong>
      {onClick && <Icon name="chevron" size={16} />}
    </>
  );
  return onClick ? (
    <button className="metric-card" type="button" aria-pressed={active} onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className="metric-card">{content}</div>
  );
}

function useProjectData(url, version) {
  const [value, setValue] = useState(null),
    [error, setError] = useState(null),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    api(url)
      .then((data) => {
        if (live) {
          setValue({ url, data });
          setError(null);
        }
      })
      .catch((error) => {
        if (live) setError({ url, message: error.message });
      });
    return () => {
      live = false;
    };
  }, [url, version, attempt]);
  return [
    value?.url === url ? value.data : null,
    error?.url === url ? error.message : '',
    () => {
      setError(null);
      setAttempt((value) => value + 1);
    },
  ];
}

export function NativeList({ version }) {
  const [data, error, retry] = useProjectData(endpoint, version);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('tree');
  const [period, setPeriod] = useState('all');
  const listTitle = useRef(null);
  const searchInput = useRef(null);
  const projects = data?.items || [];
  const countsVerified = data?.countsVerified;
  const range = countsVerified ? period : 'all';
  const search = query.trim().toLocaleLowerCase();
  const now = Date.now();
  const items = projects.filter((project) => {
    if (search && ![project.name, ...project.paths].join(' ').toLocaleLowerCase().includes(search))
      return false;
    if (scope === 'tree' && !search && range === 'all' && project.parent) return false;
    if (scope === 'sessions' && countsVerified && !project.count) return false;
    if (scope === 'reviewed' && !project.reviewedAt) return false;
    return current(project.last, range, now);
  });
  const childCounts = new Map();
  for (const project of projects) {
    if (project.parent) childCounts.set(project.parent, (childCounts.get(project.parent) || 0) + 1);
  }

  function select(nextScope, nextPeriod = 'all') {
    setQuery('');
    setScope(nextScope);
    setPeriod(nextPeriod);
    focusSection(listTitle.current);
  }
  function reset() {
    setQuery('');
    setScope('tree');
    setPeriod('all');
    searchInput.current?.focus();
  }
  const selected = (nextScope, nextPeriod = 'all') =>
    scope === nextScope && range === nextPeriod && !search;
  const total = projects.reduce((sum, project) => (project.parent ? sum : sum + project.count), 0);
  const hasFilters = search || scope !== 'tree' || range !== 'all';

  return (
    <>
      {data && (
        <section className="metric-grid" aria-label="项目指标">
          <Metric
            label="Codex 项目"
            value={countValue(projects.length)}
            onClick={() => select('all')}
            active={selected('all')}
          />
          <Metric
            label="项目对话"
            value={countValue(total, countsVerified)}
            onClick={countsVerified ? () => select('sessions') : undefined}
            active={selected('sessions')}
          />
          <Metric
            label="近 7 天活跃项目"
            value={countValue(
              projects.filter((project) => current(project.last, '7', now)).length,
              countsVerified,
            )}
            onClick={countsVerified ? () => select('all', '7') : undefined}
            active={selected('all', '7')}
          />
          <Metric
            label="已整理项目"
            value={countValue(projects.filter((project) => project.reviewedAt).length)}
            onClick={() => select('reviewed')}
            active={selected('reviewed')}
          />
        </section>
      )}
      <section className="list-shell native-list" aria-labelledby="native-list-title">
        <div className="toolbar native-toolbar">
          <div className="list-heading">
            <h2 id="native-list-title" ref={listTitle} tabIndex={-1}>
              项目列表
            </h2>
            {data && (
              <span className="result-count" aria-live="polite">
                {countValue(items.length)} 个项目
              </span>
            )}
          </div>
          {data && (
            <div className="list-controls">
              <label className="search">
                <Icon name="search" size={16} />
                <input
                  ref={searchInput}
                  aria-label="搜索 Codex 项目"
                  placeholder="搜索项目或目录"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                {query && (
                  <button
                    type="button"
                    aria-label="清除搜索"
                    onClick={() => {
                      setQuery('');
                      searchInput.current?.focus();
                    }}
                  >
                    <Icon name="close" size={15} />
                  </button>
                )}
              </label>
              <select
                className="view-select"
                aria-label="项目范围"
                value={scope}
                onChange={(event) => setScope(event.target.value)}
              >
                <option value="tree">项目层级</option>
                <option value="all">全部项目</option>
                <option value="sessions" disabled={!countsVerified}>
                  有对话
                </option>
                <option value="reviewed">已整理</option>
              </select>
              {countsVerified && (
                <PeriodSelect value={period} onChange={setPeriod} label="项目更新时间" />
              )}
            </div>
          )}
        </div>
        {error && (
          <StatePanel
            kind="error"
            title="项目列表读取失败"
            detail={error}
            action={
              <button type="button" className="secondary" onClick={retry}>
                重试
              </button>
            }
          />
        )}
        {!data && !error && <StatePanel kind="loading" title="正在读取 Codex 项目" />}
        {items.length > 0 && (
          <div className="native-table-wrap">
            <table className="native-table" aria-label="Codex 项目">
              <thead>
                <tr>
                  <th scope="col">项目</th>
                  <th scope="col">对话数</th>
                  <th scope="col">最近会话</th>
                  <th scope="col">项目整理</th>
                </tr>
              </thead>
              <tbody>
                {items.map((project) => {
                  const children = childCounts.get(project.id) || 0;
                  return (
                    <tr key={project.id}>
                      <td>
                        <a className="project-entry" href={page(project.id)} title={project.name}>
                          <span className="project-icon">
                            <Icon name="folder" size={16} />
                          </span>
                          <span className="project-entry-text">
                            <strong>{project.name}</strong>
                            <small title={project.paths[0]}>{project.paths[0] || '无本地目录'}</small>
                            {project.summary && (
                              <small className="compact-brief">{project.summary}</small>
                            )}
                          </span>
                        </a>
                      </td>
                      <td className="numeric-cell">
                        <strong>{countValue(project.count, countsVerified)}</strong>
                        {children > 0 && <small>{children} 个子项目</small>}
                      </td>
                      <td className="time-cell">
                        <time title={project.last ? exact(project.last) : undefined}>
                          {shortDate(project.last)}
                        </time>
                      </td>
                      <td className="native-brief">
                        {project.summary ? (
                          <>
                            <span>{project.summary}</span>
                            <small>{shortDate(project.reviewedAt)}</small>
                          </>
                        ) : (
                          <small>待整理</small>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {data && !items.length && !error && (
          <StatePanel
            title={hasFilters ? '没有匹配的项目' : '暂无 Codex 项目'}
            detail={hasFilters ? '调整项目范围、时间或搜索词后再查看。' : undefined}
            action={
              hasFilters ? (
                <button type="button" className="secondary" onClick={reset}>
                  清除筛选
                </button>
              ) : (
                <a className="secondary" href="#/native/new">
                  新建项目
                </a>
              )
            }
          />
        )}
      </section>
    </>
  );
}

export function NativeCreate({ initialPath }) {
  const [cwd, setCwd] = useState(initialPath || ''),
    [name, setName] = useState(initialPath ? folderName(initialPath) : '');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function pick() {
    try {
      const result = await api('/api/picker', {});
      if (result.error) setError(result.error);
      if (result.path) {
        setCwd(result.path);
        if (!name.trim()) setName(folderName(result.path));
      }
    } catch (error) {
      setError(error.message);
    }
  }
  async function create(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api(endpoint, { name, cwd: cwd.trim() });
      go('native/' + idPart(result.id));
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="narrow">
      <a className="back" href="#/">
        <Icon name="back" size={15} />
        项目
      </a>
      <div className="page-heading">
        <h1>新建 Codex 项目</h1>
      </div>
      <form className="panel form" onSubmit={create}>
        <label>
          项目名称
          <input
            value={name}
            maxLength={120}
            required
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="field-line">
          <label className="grow">
            项目目录
            <input
              value={cwd}
              required
              onChange={(event) => setCwd(event.target.value)}
              placeholder="/Users/…/项目"
            />
          </label>
          <button className="secondary" type="button" onClick={pick}>
            <Icon name="folder" />
            选取
          </button>
        </div>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <a className="secondary" href="#/">
            取消
          </a>
          <button className="primary" disabled={busy}>
            {busy ? '正在创建…' : '创建项目'}
          </button>
        </div>
      </form>
    </div>
  );
}

const dateKey = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const dateLabel = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: 'numeric',
  day: 'numeric',
});

function ActivityDetails({ sessions, now }) {
  const dates = new Map();
  for (let offset = 6; offset >= 0; offset--) {
    const date = now - offset * day;
    dates.set(dateKey.format(date), { label: dateLabel.format(date), count: 0 });
  }
  for (const { updated } of sessions) {
    if (!updated) continue;
    const entry = dates.get(dateKey.format(updated));
    if (entry) entry.count++;
  }
  const counts = [...dates.values()];
  const peak = Math.max(...counts.map((entry) => entry.count));
  return (
    <details className="disclosure activity-disclosure">
      <summary>会话活动明细</summary>
      {peak ? (
        <>
          <p className="hint">近 7 个自然日内已授权对话的最后更新时间分布</p>
          <ul className="activity-chart" aria-label="按天统计的已授权对话更新">
            {counts.map(({ label, count }) => (
              <li key={label}>
                <span>{label}</span>
                <meter min={0} max={peak} value={count} aria-label={label + '更新的对话'} />
                <strong>{countValue(count)}</strong>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="hint">近 7 个自然日内没有已授权对话更新。</p>
      )}
    </details>
  );
}

export function NativeDetail({ id, branch, version }) {
  const [browse, setBrowse] = useState(!!branch);
  useEffect(() => {
    if (branch) setBrowse(true);
  }, [branch]);
  const params = new URLSearchParams();
  if (branch) params.set('dir', branch);
  if (browse || branch) params.set('browse', '1');
  const [detail, loadError, retry] = useProjectData(endpoint + '/' + idPart(id) + '?' + params, version);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [period, setPeriod] = useState('all');
  const conversationTitle = useRef(null);
  const directoryTitle = useRef(null);
  useEffect(() => {
    setShowAll(false);
    setPeriod('all');
    setError('');
  }, [id, branch]);

  if (!detail)
    return (
      <>
        <a className="back" href="#/">
          <Icon name="back" size={15} />
          项目
        </a>
        <StatePanel
          kind={loadError ? 'error' : 'loading'}
          title={loadError ? '项目读取失败' : '正在读取项目'}
          detail={loadError}
          action={
            loadError && (
              <button className="secondary" type="button" onClick={retry}>
                重试
              </button>
            )
          }
        />
      </>
    );
  const { project, cwd, allowed, exists, review } = detail;
  const now = Date.now();
  const canFilterSessions = detail.sessions.some((session) => session.updated > 0);
  const sessionRange = canFilterSessions ? period : 'all';
  const sessions = detail.sessions.filter((session) => current(session.updated, sessionRange, now));
  const rows = showAll ? sessions : sessions.slice(0, 12);
  function selectSessions(nextPeriod) {
    setShowAll(false);
    setPeriod(nextPeriod);
    focusSection(conversationTitle.current);
  }
  const root = project.paths
    .filter((path) => cwd === path || cwd.startsWith(path + '/'))
    .sort((a, b) => b.length - a.length)[0];
  const steps = root && branch && branch !== root ? branch.slice(root.length + 1).split('/') : [];
  async function access(recursive, openChat) {
    setBusy(true);
    setError('');
    try {
      if (!allowed || recursive)
        await api('/api/codex/project-access', { projectId: id, cwd, recursive });
      if (openChat) go('codex/new/' + idPart(cwd) + '/' + idPart(id));
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <nav className="project-crumb" aria-label="项目路径">
        <a href="#/">项目</a>
        <span>/</span>
        <a href={page(id)}>{project.name}</a>
        {steps.map((label, index) => (
          <React.Fragment key={index}>
            <span>/</span>
            <a href={page(id, root + '/' + steps.slice(0, index + 1).join('/'))}>{label}</a>
          </React.Fragment>
        ))}
      </nav>
      <div className="page-heading project-heading native-heading">
        <div>
          <h1>{steps.at(-1) || project.name}</h1>
          <p className="mono">{cwd || '无本地目录'}</p>
        </div>
        {exists && (
          <div className="detail-actions">
            {branch && !project.paths.includes(cwd) && (
              <a className="secondary" href={'#/native/new/' + idPart(cwd)}>
                登记为项目
              </a>
            )}
            <button className="primary" disabled={busy} onClick={() => access(false, true)}>
              <Icon name="plus" size={16} />
              项目新增对话
            </button>
          </div>
        )}
      </div>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {loadError && (
        <p className="alert" role="alert">
          {loadError}{' '}
          <button className="secondary" type="button" onClick={retry}>
            重试
          </button>
        </p>
      )}
      <section className="metric-grid" aria-label="项目会话指标">
        <Metric
          label="对话总数"
          value={countValue(detail.count, detail.countsVerified)}
          onClick={() => selectSessions('all')}
        />
        <Metric
          label="直接归属"
          value={countValue(detail.directCount, detail.countsVerified)}
          onClick={() => focusSection(directoryTitle.current)}
        />
        <Metric
          label="近 7 天有更新"
          value={countValue(detail.recentCount, detail.countsVerified)}
          onClick={canFilterSessions ? () => selectSessions('7') : undefined}
        />
        <Metric label="最近会话" value={shortDate(detail.last)} />
      </section>
      {!branch && <ReviewPanel key={id} id={id} review={review} />}
      {detail.workbench.length > 0 && (
        <section className="panel detail-section">
          <h2>已确认进展</h2>
          <ul className="native-rows">
            {detail.workbench.map((item) => (
              <li key={item.id}>
                <a href={'#/project/' + item.id}>
                  <span>
                    <strong>{item.name}</strong>
                    <small>
                      {item.goal} · {item.next}
                    </small>
                  </span>
                  <span className="badge">{item.stage}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="panel detail-section">
        <div className="section-heading">
          <h2 ref={directoryTitle} tabIndex={-1}>
            子项目与目录
          </h2>
          {exists && !browse && !branch && (
            <button className="secondary" onClick={() => setBrowse(true)}>
              <Icon name="folder" size={16} />
              浏览目录
            </button>
          )}
        </div>
        {project.paths.length > 1 && (
          <label className="folder-select">
            项目根目录
            <select
              value={root || project.paths[0]}
              onChange={(event) => go('native/' + idPart(id) + '/' + idPart(event.target.value))}
            >
              {project.paths.map((path) => (
                <option key={path} value={path}>
                  {path}
                </option>
              ))}
            </select>
          </label>
        )}
        <ul className="native-rows">
          {detail.children.map((item) => (
            <li key={item.id}>
              <a href={page(item.id)}>
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.paths[0]}</small>
                </span>
                <span>
                  {countValue(item.count, detail.countsVerified)} 条对话 <Icon name="arrow" size={14} />
                </span>
              </a>
            </li>
          ))}
          {detail.folders
            .filter((folder) => !detail.children.some((item) => item.id === folder.projectId))
            .map((folder) => (
              <li key={folder.path}>
                <a href={folder.projectId ? page(folder.projectId) : page(id, folder.path)}>
                  <span>
                    <Icon name="folder" size={16} />
                    <strong>{folder.name}</strong>
                  </span>
                  <span>
                    {countValue(folder.count, detail.countsVerified)} 条对话{' '}
                    <Icon name="arrow" size={14} />
                  </span>
                </a>
              </li>
            ))}
        </ul>
        {browse && !detail.folders.length && !detail.children.length && (
          <p className="hint">当前目录下没有子目录。</p>
        )}
        {!exists && <p className="hint">当前目录不可用。</p>}
      </section>
      <section className="panel detail-section">
        <div className="section-heading">
          <h2 ref={conversationTitle} tabIndex={-1}>
            可打开的对话 <span className="count">{countValue(sessions.length)}</span>
          </h2>
          <div className="detail-actions">
            {canFilterSessions && (
              <PeriodSelect
                value={period}
                label="对话更新时间"
                onChange={(nextPeriod) => {
                  setPeriod(nextPeriod);
                  setShowAll(false);
                }}
              />
            )}
            {exists && detail.sessions.length < detail.count && (
              <button className="secondary" disabled={busy} onClick={() => access(true, false)}>
                授权此目录及子目录
              </button>
            )}
          </div>
        </div>
        {detail.sessions.length > 0 && <ActivityDetails sessions={detail.sessions} now={now} />}
        <ul className="native-rows conversation-rows">
          {rows.map((row) => {
            const title = row.name || '会话 ' + row.id.slice(-8);
            return (
              <li key={row.id}>
                <a href={'#/codex/' + idPart(row.id)} title={title}>
                  <span className="conversation-main">
                    <strong>{title}</strong>
                    <small title={row.cwd}>{row.cwd}</small>
                  </span>
                  <time title={row.updated ? exact(row.updated) : undefined}>
                    {shortDate(row.updated)}
                  </time>
                </a>
              </li>
            );
          })}
        </ul>
        {!rows.length && (
          <StatePanel
            title={
              sessionRange !== 'all'
                ? '此时间范围暂无可打开的对话'
                : detail.count
                  ? '暂无已授权对话'
                  : '暂无对话'
            }
            detail={
              sessionRange === 'all' && detail.count ? '打开历史前需授权对应的会话目录。' : undefined
            }
            action={
              sessionRange !== 'all' && (
                <button className="secondary" type="button" onClick={() => setPeriod('all')}>
                  查看全部时间
                </button>
              )
            }
          />
        )}
        {sessions.length > 12 && (
          <button
            className="plain-add show-all"
            type="button"
            aria-expanded={showAll}
            onClick={() => {
              setShowAll(!showAll);
              if (showAll) focusSection(conversationTitle.current);
            }}
          >
            {showAll ? '收起对话' : '展开其余 ' + countValue(sessions.length - 12) + ' 条对话'}
          </button>
        )}
      </section>
    </>
  );
}

function ReviewPanel({ id, review }) {
  const [busy, setBusy] = useState(false),
    [localError, setError] = useState('');
  async function configure(patch) {
    setError('');
    setBusy(true);
    try {
      await api('/api/project-reviews/settings', {
        projectId: id,
        enabled: review.enabled,
        replies: review.replies,
        ...patch,
      });
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    setError('');
    setBusy(true);
    try {
      await api('/api/project-reviews/refresh', { projectId: id });
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  const report = review.report;
  const bullets = (items) => (
    <ul>
      {items.map((item, index) => (
        <li key={index}>
          {item.text}{' '}
          <span className="review-refs">
            {item.refs.map((ref) => {
              const source = report.sources.find((source) => source.ref === ref);
              return (
                source && (
                  <a className="badge" key={ref} href={source.path} title={source.title}>
                    {ref}
                  </a>
                )
              );
            })}
          </span>
        </li>
      ))}
    </ul>
  );
  return (
    <section className="panel detail-section project-review">
      <div className="section-heading">
        <div>
          <h2>Codex 项目整理</h2>
          {(report || review.checked) && (
            <p className="minor">
              {report
                ? '上次整理 ' + exact(report.at) + ' · ' + report.seen + ' 条获准对话'
                : '上次检查 ' + exact(review.checked)}
            </p>
          )}
        </div>
        <button className="secondary" disabled={busy || review.running} onClick={refresh}>
          {review.running ? '正在整理…' : '立即整理'}
        </button>
      </div>
      <div className="review-settings">
        <label className="check">
          <input
            type="checkbox"
            disabled={busy}
            checked={review.enabled}
            onChange={(event) => configure({ enabled: event.target.checked })}
          />
          自动整理
        </label>
        <label className="check">
          <input
            type="checkbox"
            disabled={busy}
            checked={review.replies}
            onChange={(event) => configure({ replies: event.target.checked })}
          />
          参考最近获准的 Codex 回复
        </label>
      </div>
      {(localError || review.error) && (
        <p className="alert" role="alert">
          {localError || review.error}
        </p>
      )}
      {report ? (
        <div className="review-result">
          <p>{report.summary}</p>
          <div className="review-columns">
            {report.changes.length > 0 && (
              <section>
                <h3>有证据的变化</h3>
                {bullets(report.changes)}
              </section>
            )}
            {report.unknowns.length > 0 && (
              <section>
                <h3>待核实</h3>
                <ul>
                  {report.unknowns.map((value, index) => (
                    <li key={index}>{value}</li>
                  ))}
                </ul>
              </section>
            )}
          </div>
          {report.next.length > 0 && (
            <details className="disclosure review-recommendations">
              <summary>
                建议下一步 <span className="count">{report.next.length}</span>
              </summary>
              {bullets(report.next)}
              <Copy
                key={report.at}
                label="复制建议"
                value={report.next.map((item, index) => index + 1 + '. ' + item.text).join('\n')}
              />
            </details>
          )}
          <details className="disclosure">
            <summary>整理依据（{report.sources.length}）</summary>
            <ul className="review-sources">
              {report.sources.map((source) => (
                <li key={source.ref}>
                  <a className="subtle-link" href={source.path}>
                    <span className="mono">{source.ref}</span>
                    {source.title}
                  </a>
                </li>
              ))}
            </ul>
          </details>
        </div>
      ) : (
        <p className="hint">{review.running ? '正在核对授权范围内的证据。' : '暂无整理结果。'}</p>
      )}
    </section>
  );
}
