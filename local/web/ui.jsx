import React, { useState } from 'react';
export function Icon({ name, size = 18 }) {
  const paths = {
    branch: 'M6 3v11a4 4 0 0 0 4 4h7 M14 15l3 3-3 3 M3 6l3-3 3 3',
    message: 'M3 5h18v12H10l-5 4v-4H3z',
    grid: 'M3 4h18v16H3z M3 9h18 M9 9v11',
    send: 'M12 19V5 M6 11l6-6 6 6',
    stop: 'M7 7h10v10H7z',
    folder: 'M3 7V5h6l2 2h10v12H3z',
    search: 'M10 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12 M15 15l5 5',
    back: 'M14 5l-7 7 7 7',
    plus: 'M12 5v14 M5 12h14',
    arrow: 'M5 12h14 M13 6l6 6-6 6',
    close: 'M6 6l12 12 M18 6L6 18',
    layers: 'M3 7l9-5 9 5-9 5z M3 12l9 5 9-5 M3 17l9 5 9-5',
    chevron: 'M9 6l6 6-6 6',
    check: 'M4 12l5 5L20 6',
    copy: 'M8 8h12v13H8z M4 16H3V3h12v1',
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
export async function api(url, value) {
  const res = await fetch(
    url,
    value === undefined
      ? { headers: { 'x-workbench-request': '1' } }
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-workbench-request': '1' },
          body: JSON.stringify(value),
        },
  );
  const data = await res.json();
  if (!res.ok) throw Error(data.error || '请求失败');
  return data;
}
export function go(route = '') {
  location.hash = '/' + route;
}
export function Back() {
  return (
    <button className="back" onClick={() => go('local')}>
      <Icon name="back" size={15} />
      项目列表
    </button>
  );
}
export function exact(n) {
  return n ? new Date(n).toLocaleString('zh-CN', { hour12: false }) : '未核实';
}

export function Copy({ value, label = '复制' }) {
  const [status, setStatus] = useState('');
  return (
    <div className="copy-action">
      <button
        type="button"
        className="secondary copy"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setStatus('已复制');
          } catch {
            setStatus('复制失败，可选择文字手动复制');
          }
        }}
      >
        <Icon name="copy" size={15} />
        {label}
      </button>
      <span className="minor" role="status">
        {status}
      </span>
    </div>
  );
}

export function StatePanel({ title, detail, action, kind = 'empty' }) {
  return (
    <div
      className={'view-state ' + kind}
      role={kind === 'loading' ? 'status' : kind === 'error' ? 'alert' : undefined}
    >
      <h2>{title}</h2>
      {detail && <p>{detail}</p>}
      {kind === 'loading' && <span className="loading-track" aria-hidden="true" />}
      {action}
    </div>
  );
}

export function focusSection(element) {
  if (!element) return;
  element.focus({ preventScroll: true });
  element.scrollIntoView({
    block: 'start',
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
  });
}
