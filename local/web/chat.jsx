import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AgentMarkdown } from '../../apps/web/src/components/assistant/AgentMarkdown.tsx';
import { api, go, Icon } from './ui.jsx';

const sessionPath = (id) => 'codex/' + encodeURIComponent(id);
const threadApi = (id) => '/api/codex/thread/' + encodeURIComponent(id);
const basename = (dir) => dir?.split('/').pop() || dir || '';
const shortDate = (at) =>
  at
    ? new Intl.DateTimeFormat('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(at)
    : '';
const titleFor = (session) =>
  session.name ||
  (session.owned ? '工作台对话' : '本地对话') +
    (session.updated ? ' · ' + shortDate(session.updated) : ' ' + session.id.slice(-8));
const combined = (before, after) => [
  ...new Map([...before, ...after].map((item) => [item.id, item])).values(),
];

export function Chat({ id, cwdHint, projectHint, revision, indexVersion }) {
  const [index, setIndex] = useState(null);
  const [indexError, setIndexError] = useState('');
  const [view, setView] = useState(null);
  const [run, setRun] = useState(null);
  const [directory, setDirectory] = useState('');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [reading, setReading] = useState(false);
  const [earlier, setEarlier] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const history = useRef(null),
    composer = useRef(null);
  const pinned = useRef(true),
    preserve = useRef(null),
    handoff = useRef(null);
  const route = useRef(id);
  route.current = id;

  async function reloadIndex(live = () => true) {
    try {
      const next = await api('/api/codex/sessions');
      if (live()) {
        setIndex(next);
        setIndexError('');
      }
    } catch (e) {
      if (live()) setIndexError(e.message);
    }
  }

  useEffect(() => {
    let live = true;
    const refresh = () => {
      if (!document.hidden) reloadIndex(() => live);
    };
    refresh();
    document.addEventListener('visibilitychange', refresh);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [revision, indexVersion]);

  useEffect(() => {
    pinned.current = true;
    preserve.current = null;
    setView(null);
    setError('');
    setDraft('');
    setPending(false);
    setShowSessions(false);
    const immediate = handoff.current?.threadId === id ? handoff.current : null;
    setRun(immediate);
    handoff.current = null;
    if (!id) {
      setReading(false);
      return;
    }
    let live = true;
    setReading(true);
    api(threadApi(id))
      .then((next) => {
        if (!live) return;
        setView(next);
        setRun(next.run || immediate);
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setReading(false);
      });
    return () => {
      live = false;
    };
  }, [id, revision]);

  useEffect(() => {
    if (!id || run?.status !== 'running') return;
    let live = true,
      timer;
    async function poll() {
      try {
        const result = await api('/api/codex/turn/' + encodeURIComponent(id));
        if (!live) return;
        if (!result || result.status !== 'running') {
          const next = await api(threadApi(id)).catch(() => null);
          if (live) {
            if (next) setView(next);
            setRun(result);
            reloadIndex(() => live);
          }
          return;
        }
        setRun(result);
      } catch (e) {
        if (live) setError(e.message);
      }
      if (live) timer = setTimeout(poll, 450);
    }
    timer = setTimeout(poll, 280);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [id, run?.status]);

  const directories = index?.directories || [];
  const allowedDirectory = directories.includes(cwdHint) ? cwdHint : '';
  const location = projectHint
    ? allowedDirectory
    : directories.includes(directory)
      ? directory
      : allowedDirectory || directories[0] || '';
  const busy = pending || run?.status === 'running';
  const messages = combined(view?.messages || [], run?.messages || []);
  const session = index?.sessions.find((row) => row.id === id);
  const search = query.trim().toLocaleLowerCase();
  const visible = (index?.sessions || []).filter(
    (row) => !search || [row.name, row.cwd, row.id].join(' ').toLocaleLowerCase().includes(search),
  );

  useLayoutEffect(() => {
    const container = history.current;
    if (!container) return;
    if (preserve.current) {
      container.scrollTop = preserve.current.top + container.scrollHeight - preserve.current.height;
      preserve.current = null;
    } else if (pinned.current) container.scrollTop = container.scrollHeight;
  }, [view, run]);

  async function submit(e) {
    e.preventDefault();
    if (!draft.trim() || busy || (id ? !view : !location)) return;
    const origin = id;
    setPending(true);
    setError('');
    try {
      const result = await api('/api/codex/send', {
        ...(id ? { threadId: id } : { cwd: location, ...(projectHint && { projectId: projectHint }) }),
        message: draft,
        requestId: crypto.randomUUID(),
      });
      reloadIndex();
      if (route.current !== origin) return;
      setDraft('');
      pinned.current = true;
      if (result.threadId === id) setRun(result);
      else {
        handoff.current = result;
        go(sessionPath(result.threadId));
      }
    } catch (e) {
      if (route.current === origin) setError(e.message);
    } finally {
      if (route.current === origin) setPending(false);
    }
  }

  async function fork() {
    setError('');
    setPending('fork');
    try {
      const result = await api('/api/codex/fork', { threadId: id });
      reloadIndex();
      if (route.current === id) go(sessionPath(result.id));
    } catch (error) {
      if (route.current === id) setError(error.message);
    } finally {
      if (route.current === id) setPending(false);
    }
  }

  async function stop() {
    setError('');
    try {
      await api('/api/codex/stop', { threadId: id });
    } catch (e) {
      setError(e.message);
    }
  }

  async function loadEarlier() {
    setEarlier(true);
    setError('');
    try {
      const page = await api(threadApi(id) + '?cursor=' + encodeURIComponent(view.cursor));
      if (route.current === id) {
        const el = history.current;
        preserve.current = { height: el.scrollHeight, top: el.scrollTop };
        setView((current) => ({
          ...current,
          messages: combined(page.messages, current.messages),
          cursor: page.cursor,
        }));
      }
    } catch (e) {
      if (route.current === id) setError(e.message);
    } finally {
      setEarlier(false);
    }
  }

  function newChat() {
    setShowSessions(false);
    if (id) go('codex');
    else composer.current?.focus();
  }

  return (
    <section className="chat-workspace" aria-label="Codex 工作区">
      <div className="chat-mobile-bar">
        <button
          className="secondary"
          onClick={() => setShowSessions(!showSessions)}
          aria-expanded={showSessions}
          aria-controls="session-list"
        >
          <Icon name="layers" />
          会话列表
        </button>
        <button className="secondary" onClick={newChat}>
          <Icon name="plus" />
          新对话
        </button>
      </div>
      <aside
        className={'chat-sidebar' + (showSessions ? ' reveal' : '')}
        id="session-list"
        aria-label="本地会话"
      >
        <div className="chat-side-top">
          <div className="chat-side-title">
            <h2>会话</h2>
            <button className="secondary chat-new" onClick={newChat}>
              <Icon name="plus" size={16} />
              新对话
            </button>
          </div>
          <label className="search chat-search">
            <Icon name="search" size={16} />
            <input
              aria-label="搜索会话"
              placeholder="搜索会话或目录"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>
        <ul className="chat-list">
          {visible.map((row) => (
            <li key={row.id}>
              <a
                href={'#/' + sessionPath(row.id)}
                aria-current={row.id === id ? 'page' : undefined}
                onClick={() => setShowSessions(false)}
              >
                <span className="chat-row-icon">
                  <Icon name="message" size={16} />
                </span>
                <span className="chat-row-text">
                  <strong>{titleFor(row)}</strong>
                  <small>
                    {basename(row.cwd)}
                    {row.name && row.updated ? ' · ' + shortDate(row.updated) : ''}
                  </small>
                </span>
              </a>
            </li>
          ))}
          {!visible.length && (
            <li className="chat-list-empty">
              {indexError ||
                (!index
                  ? '正在读取本地索引…'
                  : search
                    ? '没有匹配的会话'
                    : index.status === '未接通'
                      ? index.reason
                      : '授权范围内暂无会话')}
            </li>
          )}
        </ul>
        <div className="chat-side-foot">
          <span className="indicator">
            <i className={index?.status === '已接通' ? 'live' : ''} />
            {index?.status || '连接中'}
          </span>
          <a className="subtle-link" href="#/codex/scopes">
            <Icon name="folder" size={16} />
            会话范围
          </a>
        </div>
      </aside>

      <div className="chat-main">
        <div className="chat-title">
          <div>
            <h1>{id ? view?.name || (session ? titleFor(session) : '本地会话') : '与 Codex 对话'}</h1>
            {id && (view?.cwd || session?.cwd) && (
              <p title={view?.cwd || session.cwd}>{view?.cwd || session.cwd}</p>
            )}
          </div>
          <div className="chat-title-actions">
            {(run?.model || view?.model) && (
              <span className="chat-model">{run?.model || view.model}</span>
            )}
            {id && view && (
              <button className="secondary" disabled={busy} onClick={fork}>
                <Icon name="branch" size={15} />
                创建分支
              </button>
            )}
          </div>
        </div>

        <div
          ref={history}
          className="chat-history"
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
          }}
          aria-label="对话记录"
        >
          <div className="chat-transcript">
            {view?.cursor && (
              <button className="earlier" onClick={loadEarlier} disabled={earlier}>
                {earlier ? '正在加载…' : '查看更早的消息'}
              </button>
            )}
            {!id && (
              <div className="chat-welcome">
                <div className="chat-emblem">
                  <span className="brand-mark" />
                </div>
                <h2>{directories.length ? '工作目录' : '选择会话目录'}</h2>
                {directories.length ? (
                  <label className="chat-directory">
                    <Icon name="folder" size={16} />
                    <select
                      aria-label="工作目录"
                      value={location}
                      onChange={(e) => setDirectory(e.target.value)}
                    >
                      {(projectHint ? [location].filter(Boolean) : directories).map((dir) => (
                        <option key={dir} value={dir} title={dir}>
                          {basename(dir)} — {dir}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <a className="secondary" href="#/codex/scopes">
                    授权会话目录
                  </a>
                )}
              </div>
            )}
            {id && reading && !messages.length && (
              <p className="chat-read-state" role="status">
                正在读取会话…
              </p>
            )}
            {id && view && !messages.length && !busy && (
              <p className="chat-read-state">此会话暂无文字消息。</p>
            )}
            <ol className="chat-messages">
              {messages.map((message) => (
                <li className={'chat-message ' + message.role} key={message.id}>
                  {message.role === 'assistant' && (
                    <span className="message-by">
                      <span className="brand-mark" />
                      Codex
                    </span>
                  )}
                  <div
                    className="message-text"
                    aria-label={message.role === 'user' ? '你的消息' : undefined}
                  >
                    {message.role === 'assistant' ? <AgentMarkdown text={message.text} /> : message.text}
                  </div>
                </li>
              ))}
            </ol>
            {busy && (
              <div className="chat-generating" role="status">
                <i />
                {pending === 'fork' ? '正在创建分支…' : pending ? '正在发送…' : 'Codex 正在回复'}
              </div>
            )}
            {run?.status === 'interrupted' && (
              <p className="chat-read-state" role="status">
                已停止生成
              </p>
            )}
          </div>
        </div>

        <div className="chat-bottom">
          {(error || run?.error) && (
            <p className="chat-error" role="alert">
              {error || run.error}
            </p>
          )}
          <form className="composer" onSubmit={submit}>
            <textarea
              ref={composer}
              aria-label="给 Codex 发消息"
              placeholder="给 Codex 发消息"
              value={draft}
              maxLength={16000}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.currentTarget.form.requestSubmit();
                }
              }}
              disabled={id ? !view && !run : !location}
              rows={2}
            />
            <div className="composer-actions">
              <span className="composer-key">⌘ ↵ 发送</span>
              {run?.status === 'running' ? (
                <button className="secondary" type="button" onClick={stop}>
                  <Icon name="stop" size={14} />
                  停止
                </button>
              ) : (
                <button
                  className="primary"
                  type="submit"
                  disabled={!draft.trim() || busy || (id ? !view : !location)}
                >
                  <Icon name="send" size={16} />
                  发送
                </button>
              )}
            </div>
          </form>
          <p className="composer-note">本机 Codex · 只读对话</p>
        </div>
      </div>
    </section>
  );
}

export function ChatScopes({ state, save }) {
  const [scopes, setScopes] = useState(state.chatDirs);
  const [added, setAdded] = useState('');
  const [recursive, setRecursive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision] = useState(state.revision);
  const inherited = state.roots.filter((root) => root.sessions);
  async function picker() {
    try {
      const selected = await api('/api/picker', {});
      if (selected.path) setAdded(selected.path);
      if (selected.error) setError(selected.error);
    } catch (e) {
      setError(e.message);
    }
  }
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const dirs = added.trim() ? [...scopes, { path: added.trim(), exact: !recursive }] : scopes;
      await save('/api/codex/scopes', { dirs, revision });
      go('codex');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="narrow">
      <a className="back" href="#/codex">
        <Icon name="back" size={15} />
        Codex
      </a>
      <div className="page-heading">
        <div>
          <h1>会话范围</h1>
          <p>这里授权的是 Codex 会话目录。</p>
        </div>
      </div>
      <form className="panel form scope-form" onSubmit={submit}>
        {scopes.length > 0 && (
          <ul className="scope-list">
            {scopes.map((scope) => (
              <li key={scope.path}>
                <div>
                  <strong>{scope.path}</strong>
                  <small>{scope.exact ? '仅此目录' : '包含子目录'}</small>
                </div>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setScopes(scopes.filter((v) => v.path !== scope.path))}
                  aria-label={'移除此目录 ' + scope.path}
                >
                  移除
                </button>
              </li>
            ))}
          </ul>
        )}
        {inherited.length > 0 && (
          <section>
            <h2>项目目录已授权</h2>
            <ul className="scope-list">
              {inherited.map((scope) => (
                <li key={scope.path}>{scope.path}</li>
              ))}
            </ul>
          </section>
        )}
        <div className="field-line">
          <label className="grow">
            添加目录
            <input
              value={added}
              onChange={(e) => setAdded(e.target.value)}
              placeholder="/Users/…/项目"
            />
          </label>
          <button className="secondary" type="button" onClick={picker}>
            <Icon name="folder" />
            选取
          </button>
        </div>
        <label className="check">
          <input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} />
          包含子目录
        </label>
        {error && (
          <p className="chat-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <a className="secondary" href="#/codex">
            取消
          </a>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? '正在保存…' : '保存范围'}
          </button>
        </div>
      </form>
    </div>
  );
}
