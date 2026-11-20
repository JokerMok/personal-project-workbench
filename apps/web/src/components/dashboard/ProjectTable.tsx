import React from 'react';
import { Table, TableBody, TableCell, TableContainer, TableHead, TableRow } from '@mui/material';

export const groups = ['需要我处理', '最近有变化', '新发现待确认', '其他'];
export function shortTime(n: number) {
  if (!n) return '未核实';
  return new Date(n).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
type ProjectRow = {
  id: string;
  name: string;
  category: string;
  group: string;
  goal: string;
  stage: string;
  flags: string[];
  latest: { title: string; origin: string } | null;
  candidate: boolean;
  locations: unknown[];
  next: string;
  updated: number;
  deployment: string;
};
export const ProjectTable = React.memo(function ProjectTable({
  projects,
  onSelectProject,
}: {
  projects: ProjectRow[];
  onSelectProject: (id: string) => void;
}) {
  return (
    <TableContainer className="table-wrap">
      <Table size="small" stickyHeader aria-label="项目列表" className="project-table">
        <TableHead>
          <TableRow>
            {['项目', '当前里程碑', '最近实质变化 / 证据', '下一步', '更新时间'].map((h) => (
              <TableCell key={h}>{h}</TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {groups.map((group, idx) => {
            const rows = projects
              .filter((p) => p.group === group)
              .sort((a, b) => b.updated - a.updated || a.name.localeCompare(b.name, 'zh-CN'));
            if (!rows.length) return null;
            return (
              <React.Fragment key={group}>
                <TableRow className={'section section-' + idx}>
                  <TableCell colSpan={5}>
                    <span className="section-dot" />
                    {group}
                    <span className="count">{rows.length}</span>
                  </TableCell>
                </TableRow>
                {rows.map((p) => (
                  <TableRow
                    key={p.id}
                    hover
                    className="project-row"
                    tabIndex={0}
                    aria-label={'查看' + p.name}
                    onClick={() => onSelectProject(p.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelectProject(p.id);
                      }
                    }}
                  >
                    <TableCell>
                      <div className="name">{p.name}</div>
                      <div className="minor">
                        {p.category} · {p.locations.length} 个目录
                      </div>
                    </TableCell>
                    <TableCell>
                      <div>{p.goal}</div>
                      <div className="tags">
                        <span className={'badge ' + (p.stage === '已交付' ? 'green' : '')}>
                          {p.stage}
                        </span>
                        {p.deployment === '已上线' && <span className="badge green">已上线</span>}
                        {p.flags.map((f) => (
                          <span className="badge amber" key={f}>
                            {f}
                          </span>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div>{p.latest?.title || '未核实'}</div>
                      <div className="minor">
                        {p.latest?.origin || (p.candidate ? '目录发现' : '尚无实质变化证据')}
                      </div>
                    </TableCell>
                    <TableCell>{p.next}</TableCell>
                    <TableCell>
                      <time title={new Date(p.updated).toLocaleString('zh-CN')}>
                        {shortTime(p.updated)}
                      </time>
                    </TableCell>
                  </TableRow>
                ))}
              </React.Fragment>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
});
