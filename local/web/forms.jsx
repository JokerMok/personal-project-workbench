import React, { useState } from 'react';
import { api, Back, go, Icon, exact } from './ui.jsx';
const blank = () => ({ path: '', category: '个人', sessions: false });
const parent = (value) => value.slice(0, value.lastIndexOf('/'));
const basename = (value) => value.split('/').pop();
const triggers = { blocked: '阻塞', review: '需验收', conflict: '证据冲突' };

export function Setup({ state, save }) {
  const [rows, setRows] = useState(() =>
    state.roots.length ? state.roots.map((r) => ({ ...r })) : [blank()],
  );
  const [revision] = useState(state.revision),
    [err, setErr] = useState(''),
    [busy, setBusy] = useState(false);
  const update = (index, patch) =>
    setRows((prev) => prev.map((v, i) => (i === index ? { ...v, ...patch } : v)));
  async function pick(i) {
    setErr('');
    try {
      const result = await api('/api/picker', {});
      if (result.path) update(i, { path: result.path });
      if (result.error) setErr(result.error);
    } catch (e) {
      setErr(e.message);
    }
  }
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await save('/api/roots', { revision, roots: rows.map((v) => ({ ...v, path: v.path.trim() })) });
      go('local');
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="narrow">
      <Back />
      <div className="page-heading">
        <div>
          <h1>扫描目录</h1>
          <p>只采集你在这里授权的目录。每个目录可以包含多个项目。</p>
        </div>
      </div>
      <form onSubmit={submit} className="panel form">
        {rows.map((r, i) => (
          <fieldset className="root-field" key={i}>
            <legend>目录 {i + 1}</legend>
            <div className="field-line">
              <label className="grow">
                本机目录
                <input
                  required
                  placeholder="/Users/…/项目"
                  value={r.path}
                  onChange={(e) => update(i, { path: e.target.value })}
                />
              </label>
              <button className="secondary" type="button" onClick={() => pick(i)}>
                <Icon name="folder" />
                选取
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={'移除目录 ' + (i + 1)}
                onClick={() => setRows(rows.filter((_, j) => i !== j))}
              >
                <Icon name="close" />
              </button>
            </div>
            <div className="root-options">
              <label>
                默认分类
                <select value={r.category} onChange={(e) => update(i, { category: e.target.value })}>
                  <option>个人</option>
                  <option>工作</option>
                </select>
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={r.sessions}
                  onChange={(e) => update(i, { sessions: e.target.checked })}
                />
                关联此目录的 Codex 会话元数据
              </label>
            </div>
          </fieldset>
        ))}
        <button type="button" className="plain-add" onClick={() => setRows([...rows, blank()])}>
          <Icon name="plus" size={16} />
          添加目录
        </button>
        <p className="hint">会话关联只使用 ID、工作目录和时间。授权后，服务会在后台持续采集。</p>
        {err && (
          <p role="alert" className="alert">
            {err}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="secondary" onClick={() => go('local')}>
            取消
          </button>
          <button disabled={busy} className="primary">
            {busy ? '正在扫描…' : '保存并扫描'}
          </button>
        </div>
      </form>
    </div>
  );
}

function groupedHint(source, others, roots) {
  const parents = new Set(
    source.locations.map((r) => parent(r.path)).filter((p) => !roots.some((r) => r.path === p)),
  );
  return others.filter(
    (item) => item.id !== source.id && item.locations.some((r) => parents.has(parent(r.path))),
  );
}
export function Confirm({ id, state, save }) {
  const source = state.items.find((p) => p.id === id);
  if (!source)
    return (
      <>
        <Back />
        <p>这条候选线索已归组或已移出扫描范围。</p>
      </>
    );
  return <ConfirmForm source={source} state={state} save={save} />;
}
function ConfirmForm({ source, state, save }) {
  const candidates = state.items.filter((i) => i.candidate),
    projects = state.items.filter((i) => !i.candidate);
  const [suggested] = useState(() =>
    source.candidate
      ? groupedHint(source, candidates, state.roots).filter((i) => i.locations.some((r) => !r.error))
      : [],
  );
  const [matches] = useState(() =>
    source.candidate
      ? projects.filter(
          (project) =>
            groupedHint(source, [project], state.roots).length ||
            project.locations.some((r) => source.locations.some((c) => c.path.startsWith(r.path + '/'))),
        )
      : [],
  );
  const [revision] = useState(state.revision);
  const defaults = (project) => {
    const initial = project ? project.members : [source.id, ...suggested.map((s) => s.id)];
    return {
      projectId: project?.id || '',
      name:
        project?.name || (suggested.length ? basename(parent(source.locations[0].path)) : source.name),
      category: project?.category || source.category,
      goal: project?.goal || '',
      criteria: project?.criteria || '',
      gate: project?.gate || 'accepted',
      required: (project?.required || ['验收记录.md']).join('\n'),
      initialNext: project?.initialNext || '',
      notify: project?.notify || Object.keys(triggers),
      members: [...new Set([...initial, ...(source.candidate ? [source.id] : [])])],
      ignored: project?.ignored || [],
    };
  };
  const [form, setForm] = useState(() =>
      defaults(source.candidate ? (matches.length === 1 ? matches[0] : null) : source),
    ),
    [err, setErr] = useState(''),
    [busy, setBusy] = useState(false);
  const put = (key, value) => setForm((old) => ({ ...old, [key]: value }));
  const toggle = (key, v, on) =>
    setForm((old) => ({
      ...old,
      [key]: on ? [...new Set([...old[key], v])] : old[key].filter((x) => x !== v),
    }));
  const current = projects.find((p) => p.id === form.projectId);
  const choices = [
    ...(current
      ? current.locations.map((row) => ({
          id: row.id,
          locations: current.locations.filter((r) => r.id === row.id),
        }))
      : []),
    ...candidates,
  ].filter((c, i, arr) => i === arr.findIndex((other) => other.id === c.id));
  const primary = choices.filter(
    (c) => c.id === source.id || suggested.some((s) => s.id === c.id) || current?.members.includes(c.id),
  );
  const others = choices.filter((c) => !primary.includes(c));
  const sessions = [
    ...new Map(
      state.items
        .flatMap((p) => p.availableSessions)
        .filter((s) => form.members.includes(s.owner))
        .map((s) => [s.id, s]),
    ).values(),
  ];
  const directory = (c) => (
    <label key={c.id} className="option">
      <input
        type="checkbox"
        checked={form.members.includes(c.id)}
        onChange={(e) => toggle('members', c.id, e.target.checked)}
      />
      <span>
        {c.locations.map((r) => (
          <span className="path-line" key={r.path}>
            {r.path}
          </span>
        ))}
        <small>
          {c.locations[0]?.kind === 'git' ? 'Git 仓库' : '项目目录'}
          {c.locations.length > 1 ? ' · 同一仓库的工作树' : ''}
          {suggested.some((s) => s.id === c.id) ? ' · 同一上级目录，建议归组' : ''}
        </small>
      </span>
    </label>
  );
  async function submit(e) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const id = await save('/api/projects', {
        ...form,
        revision,
        required: form.required
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
      });
      go('project/' + id);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="narrow">
      <Back />
      <div className="page-heading">
        <div>
          <h1>{source.candidate ? '确认项目归组' : '调整项目与规则'}</h1>
          <p>
            {source.candidate
              ? '核对归属与交付条件。保存后，工作台按这些规则自动更新。'
              : '变更里程碑或验收条件会开启新阶段，原有记录保存在历史中。'}
          </p>
        </div>
      </div>
      <form className="panel form" onSubmit={submit}>
        {source.candidate && projects.length > 0 && (
          <label>
            归入项目
            <select
              value={form.projectId}
              onChange={(e) => setForm(defaults(projects.find((p) => p.id === e.target.value)))}
            >
              <option value="">创建新项目</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {matches.some((m) => m.id === p.id) ? ' · 根据目录关系建议' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="field-line">
          <label className="grow">
            项目名称
            <input
              required
              maxLength={100}
              value={form.name}
              onChange={(e) => put('name', e.target.value)}
            />
          </label>
          <label>
            分类
            <select value={form.category} onChange={(e) => put('category', e.target.value)}>
              <option>个人</option>
              <option>工作</option>
            </select>
          </label>
        </div>
        <fieldset>
          <legend>关联目录与仓库</legend>
          <div className="options">{primary.map(directory)}</div>
          {others.length > 0 && (
            <details>
              <summary>其他可关联的目录（{others.length}）</summary>
              {others.map(directory)}
            </details>
          )}
        </fieldset>
        <fieldset>
          <legend>Codex 会话</legend>
          {sessions.length ? (
            <>
              <p className="hint">勾选已有会话。之后在已授权目录新建的会话会自动关联。</p>
              {sessions.map((s) => (
                <label className="option" key={s.id}>
                  <input
                    type="checkbox"
                    checked={!form.ignored.includes(s.id)}
                    onChange={(e) => toggle('ignored', s.id, !e.target.checked)}
                  />
                  <span className="mono">
                    {s.id}
                    <small>
                      {s.cwd} · {exact(s.updated)}
                    </small>
                  </span>
                </label>
              ))}
            </>
          ) : (
            <p className="hint">
              {choices.some(
                (c) =>
                  form.members.includes(c.id) &&
                  c.locations.some(
                    (r) =>
                      state.roots
                        .filter((root) => r.path === root.path || r.path.startsWith(root.path + '/'))
                        .sort((a, b) => b.path.length - a.path.length)[0]?.sessions,
                  ),
              ) && state.codex.status === '已接通'
                ? '这些目录暂无可关联会话。'
                : '未接通，可在扫描目录中授权元数据。'}
            </p>
          )}
        </fieldset>
        <fieldset className="fields">
          <legend>当前里程碑与验收规则</legend>
          <label>
            本阶段要交付什么
            <input
              required
              maxLength={360}
              value={form.goal}
              placeholder="例如，交付可导入的月度报表"
              onChange={(e) => put('goal', e.target.value)}
            />
          </label>
          <div className="field-line">
            <label className="grow">
              交付条件
              <select value={form.gate} onChange={(e) => put('gate', e.target.value)}>
                <option value="accepted">收到验收通过回执</option>
                <option value="deployed">收到部署完成回执</option>
              </select>
            </label>
          </div>
          <label>
            必须校验的证据文件
            <textarea
              required
              rows={2}
              value={form.required}
              onChange={(e) => put('required', e.target.value)}
            />
            <small>填写相对关联目录的路径，每行一个。回执须包含对应文件的 SHA-256。</small>
          </label>
          <label>
            验收说明（选填）
            <input
              value={form.criteria}
              maxLength={900}
              onChange={(e) => put('criteria', e.target.value)}
              placeholder="例如，财务负责人已确认汇总金额"
            />
          </label>
          <label>
            下一步（选填）
            <input
              value={form.initialNext}
              maxLength={500}
              onChange={(e) => put('initialNext', e.target.value)}
              placeholder="从第一件要做的事开始"
            />
          </label>
        </fieldset>
        <fieldset>
          <legend>需要提醒我处理</legend>
          <div className="checks">
            {Object.entries(triggers).map(([k, v]) => (
              <label key={k} className="check">
                <input
                  type="checkbox"
                  checked={form.notify.includes(k)}
                  onChange={(e) => toggle('notify', k, e.target.checked)}
                />
                {v}
              </label>
            ))}
          </div>
        </fieldset>
        {err && (
          <p role="alert" className="alert">
            {err}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="secondary" onClick={() => go('project/' + source.id)}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? '正在保存…' : '确认并保存'}
          </button>
        </div>
      </form>
    </div>
  );
}
