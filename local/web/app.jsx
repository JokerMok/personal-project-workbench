import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { ProjectTable } from '../../apps/web/src/components/dashboard/ProjectTable.tsx';
import { Setup, Confirm } from './forms.jsx';
import { Detail } from './detail.jsx';
import { Chat, ChatScopes } from './chat.jsx';
import { NativeList, NativeDetail, NativeCreate } from './projects.jsx';

import { api, Back, go, Icon, StatePanel } from './ui.jsx';
const routeNow = () => location.hash.replace(/^#\/?/, '').split('/');
function ProjectSource({ local = false }) {
  return (
    <nav className="segments project-source" aria-label="项目来源">
      <a className={local ? '' : 'selected'} aria-current={local ? undefined : 'page'} href="#/">
        Codex 项目
      </a>
      <a className={local ? 'selected' : ''} aria-current={local ? 'page' : undefined} href="#/local">
        扫描归组
      </a>
    </nav>
  );
}

function NativeHome({ state }) {
  return (
    <>
      <div className="page-heading project-heading">
        <div>
          <h1>项目总览</h1>
          <ProjectSource />
        </div>
        <a className="primary" href="#/native/new">
          <Icon name="plus" size={16} />
          新建项目
        </a>
      </div>
      <NativeList version={state.projectVersion} />
    </>
  );
}

function Home({ state, filter, setFilter, query, setQuery }) {
  const search = useRef(null);
  useEffect(() => {
    const jump = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener('keydown', jump);
    return () => window.removeEventListener('keydown', jump);
  }, []);
  const term = query.toLocaleLowerCase().trim();
  const items = state.items.filter(
    (p) =>
      (filter === '全部' || p.category === filter) &&
      (!term ||
        [
          p.name,
          p.goal,
          p.latest?.title,
          p.next,
          ...p.locations.map((r) => r.path),
          ...p.sessions.map((s) => s.id),
        ]
          .join(' ')
          .toLocaleLowerCase()
          .includes(term)),
  );
  const confirmed = state.items.filter((p) => !p.candidate).length;
  const candidates = state.items.length - confirmed;
  return (
    <>
      <div className="page-heading project-heading">
        <div>
          <h1>项目</h1>
          <ProjectSource local />
          {state.roots.length > 0 && (
            <span className="heading-note">
              {confirmed} 个已确认
              {candidates > 0 && (
                <>
                  <span className="sep">·</span>
                  {candidates} 个待确认
                </>
              )}
            </span>
          )}
        </div>
        {state.roots.length > 0 && (
          <a className="secondary" href="#/settings">
            <Icon name="folder" />
            扫描目录
          </a>
        )}
      </div>
      {!state.roots.length ? (
        <section className="project-start panel">
          <span className="folder-sign">
            <Icon name="folder" size={27} />
          </span>
          <div>
            <h2>添加项目目录</h2>
            <p>选择要扫描的目录，发现 Git 仓库与文档项目。</p>
          </div>
          <a className="primary" href="#/settings">
            <Icon name="plus" size={16} />
            设置扫描目录
          </a>
        </section>
      ) : (
        <div className="list-shell">
          <div className="toolbar">
            <div className="segments" role="group" aria-label="项目分类">
              {['全部', '个人', '工作'].map((x) => (
                <button
                  key={x}
                  aria-pressed={filter === x}
                  className={filter === x ? 'selected' : ''}
                  onClick={() => setFilter(x)}
                >
                  {x}
                </button>
              ))}
            </div>
            <label className="search">
              <Icon name="search" size={16} />
              <input
                ref={search}
                aria-label="搜索项目"
                placeholder="搜索项目、目录或会话"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query ? (
                <button aria-label="清空搜索" onClick={() => setQuery('')}>
                  ×
                </button>
              ) : (
                <kbd>⌘ K</kbd>
              )}
            </label>
          </div>
          {items.length ? (
            <ProjectTable projects={items} onSelectProject={(id) => go('project/' + id)} />
          ) : (
            <div className="empty">
              <Icon name="search" size={26} />
              <h2>{state.items.length ? '没有匹配的项目' : '暂未发现项目'}</h2>
              <p>
                {state.items.length
                  ? '调整搜索词或项目分类。'
                  : '在已授权目录添加项目文件后，列表会自动更新。'}
              </p>
            </div>
          )}
        </div>
      )}
    </>
  );
}
function App() {
  const [state, setState] = useState(null),
    [route, setRoute] = useState(routeNow),
    [err, setErr] = useState(''),
    [connection, setConnection] = useState('连接中');
  const [query, setQuery] = useState(''),
    [filter, setFilter] = useState('全部'),
    [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState(''),
    [detailAttempt, setDetailAttempt] = useState(0);
  useEffect(() => {
    let seq = 0,
      closed = false;
    async function refresh() {
      const id = ++seq;
      try {
        const data = await api('/api/state');
        if (!closed && id === seq) {
          setState(data);
          setErr('');
        }
      } catch (e) {
        if (!closed) setErr(e.message);
      }
    }
    refresh();
    const stream = new EventSource('/api/events');
    stream.onopen = () => setConnection('在线');
    stream.onmessage = refresh;
    stream.onerror = () => setConnection('重连中');
    const focus = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener('visibilitychange', focus);
    const change = () => {
      setRoute(routeNow());
      setDetail(null);
      setDetailError('');
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', change);
    return () => {
      closed = true;
      stream.close();
      document.removeEventListener('visibilitychange', focus);
      window.removeEventListener('hashchange', change);
    };
  }, []);
  const [screen, id, context, parentProject] = route;
  let cwdHint = '';
  if ((screen === 'codex' && id === 'new') || screen === 'native') {
    try {
      cwdHint = decodeURIComponent(context || '');
    } catch {}
  }
  useEffect(() => {
    let live = true;
    if (screen === 'project' && id)
      api('/api/detail/' + encodeURIComponent(id))
        .then((p) => {
          if (live) {
            setDetail(p);
            setDetailError('');
          }
        })
        .catch((e) => {
          if (live) setDetailError(e.message);
        });
    return () => {
      live = false;
    };
  }, [screen, id, state?.sequence, state?.scanned, detailAttempt]);
  const save = async (url, payload) => {
    const result = await api(url, payload);
    setState(result.state);
    return result.id;
  };
  return (
    <>
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('main-content').focus();
        }}
      >
        跳到主要内容
      </a>
      <header>
        <div className="top">
          <button className="brand" onClick={() => go()} aria-label="臻一项目工作台">
            <span className="brand-mark" />
            <span className="brand-title">
              臻一 <span>项目工作台</span>
            </span>
          </button>
          <nav className="global-nav" aria-label="工作台导航">
            <a href="#/" aria-current={screen !== 'codex' ? 'page' : undefined}>
              <Icon name="grid" size={16} />
              项目
            </a>
            <a href="#/codex" aria-current={screen === 'codex' ? 'page' : undefined}>
              <Icon name="message" size={16} />
              Codex
            </a>
          </nav>
          <div className="status">
            <i className={connection === '在线' ? 'live' : ''} />
            <span>采集{connection}</span>
            <span className="lastscan">
              {state?.scanned
                ? '上次扫描 ' + new Date(state.scanned).toLocaleTimeString('zh-CN', { hour12: false })
                : ''}
            </span>
          </div>
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className={screen === 'codex' ? 'codex-page' : undefined}>
        {state && err && (
          <div role="alert" className="alert">
            {err}
          </div>
        )}
        {screen !== 'codex' && state?.warning && (
          <div role="alert" className="alert">
            {state.warning}
          </div>
        )}
        {screen !== 'codex' && state?.issues?.length > 0 && (
          <details className="alert">
            <summary>{state.issues.length} 个目录未核实</summary>
            {state.issues.map((v) => (
              <p className="mono" key={v}>
                {v}
              </p>
            ))}
          </details>
        )}
        {!state ? (
          <StatePanel
            kind={err ? 'error' : 'loading'}
            title={err ? '工作台未能连接' : '正在连接本地工作台'}
            detail={err && '请确认工作台服务正在运行。'}
            action={
              err && (
                <button type="button" className="secondary" onClick={() => location.reload()}>
                  重试
                </button>
              )
            }
          />
        ) : screen === 'codex' ? (
          id === 'scopes' ? (
            <ChatScopes state={state} save={save} />
          ) : (
            <Chat
              id={id === 'new' ? '' : id}
              cwdHint={cwdHint}
              projectHint={parentProject || ''}
              revision={state.revision}
              indexVersion={state.sequence}
            />
          )
        ) : screen === 'native' ? (
          id === 'new' ? (
            <NativeCreate key={context || 'new'} initialPath={cwdHint} />
          ) : (
            <NativeDetail key={id} id={id} branch={cwdHint} version={state.projectVersion} />
          )
        ) : screen === 'settings' ? (
          <Setup state={state} save={save} />
        ) : screen === 'confirm' ? (
          <Confirm key={id} id={id} state={state} save={save} />
        ) : screen === 'project' ? (
          <>
            {detail?.id !== id && <Back />}
            {detailError && (
              <StatePanel
                kind="error"
                title="项目记录读取失败"
                detail={detailError}
                action={
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => {
                      setDetailError('');
                      setDetailAttempt((attempt) => attempt + 1);
                    }}
                  >
                    重试
                  </button>
                }
              />
            )}
            {detail?.id === id ? (
              <Detail item={detail} codex={state.codex} />
            ) : (
              !detailError && <StatePanel kind="loading" title="正在读取项目记录" />
            )}
          </>
        ) : screen === 'local' ? (
          <Home {...{ state, query, setQuery, filter, setFilter }} />
        ) : (
          <NativeHome state={state} />
        )}
      </main>
    </>
  );
}
const tokens = getComputedStyle(document.documentElement);
const token = (name) => tokens.getPropertyValue(name).trim();
const theme = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: token('--accent') },
    divider: token('--line'),
    background: { default: token('--canvas'), paper: token('--surface') },
    text: { primary: token('--ink'), secondary: token('--muted') },
  },
  typography: { fontFamily: tokens.fontFamily },
});

createRoot(document.getElementById('root')).render(
  <ThemeProvider theme={theme}>
    <App />
  </ThemeProvider>,
);
