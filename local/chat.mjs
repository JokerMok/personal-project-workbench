import { assertRollout, chatRoots, lookupSession, readSessions, sessionCwd } from './codex.mjs';
import { CodexRpc, assertChatConfig, mcpOverrides } from './codex-rpc.mjs';
import { codexDir, dataDir, inside, systemPath } from './paths.mjs';

const sandbox = { type: 'readOnly', networkAccess: false };
const instructions =
  'Answer the user in chat. Do not call tools or try to change files. If something ' +
  'depends on project data the user has not shared, say what information you need.';
const historyPage = 10;

function messageItem(item) {
  if (item.type === 'agentMessage' && typeof item.text === 'string')
    return { id: item.id, role: 'assistant', text: item.text };
  if (item.type === 'userMessage') {
    const text = item.content
      ?.map((input) => (input.type === 'text' ? input.text : '[附件]'))
      .join('\n');
    return { id: item.clientId || item.id, role: 'user', text: text || '' };
  }
  return null;
}

function visibleMessages(turns) {
  return turns.flatMap((turn) => (turn.items || []).map(messageItem).filter(Boolean));
}

function runView(run) {
  if (!run) return null;
  const { threadId, turnId, status, error, model, messages } = run;
  return { threadId, turnId, status, error, model, messages: [...messages.values()] };
}

function verifyThread(thread, cwd, expectedId) {
  if (
    !thread?.id ||
    typeof thread.cwd !== 'string' ||
    systemPath(thread.cwd) !== cwd ||
    (expectedId && thread.id !== expectedId)
  )
    throw Error('本机 Codex 返回的会话归属与授权不符');
}

export class Chat {
  constructor(board) {
    this.board = board;
    this.runs = new Map();
    this.starting = new Set();
    this.requests = new Map();
    this.workers = new Set();
    board.db.exec(
      'CREATE TABLE IF NOT EXISTS chat_threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, parent TEXT)',
    );
    this.owned = board.db.prepare('SELECT id,cwd,parent FROM chat_threads WHERE id=?');
    this.record = board.db.prepare('INSERT INTO chat_threads (id,cwd,parent) VALUES (?,?,?)');
  }

  roots() {
    return chatRoots(this.board.config);
  }

  async scope(cwd) {
    const valid = await sessionCwd(cwd, this.roots());
    if (!valid) throw Error('请先授权此会话工作目录');
    return valid;
  }

  async ready(rpc) {
    const hello = await rpc.ready;
    if (typeof hello.codexHome !== 'string' || systemPath(hello.codexHome) !== codexDir)
      throw Error('Codex 运行目录和本地会话索引不是同一来源');
    return rpc;
  }

  connect(overrides) {
    const rpc = new CodexRpc(dataDir, overrides);
    this.workers.add(rpc);
    rpc.child.once('close', () => this.workers.delete(rpc));
    return rpc;
  }

  reader() {
    if (!this.readerRpc || this.readerRpc.closed) this.readerRpc = this.connect();
    return this.ready(this.readerRpc);
  }

  async worker(cwd, login = true) {
    const reader = await this.reader();
    const { config } = await reader.call('config/read', { cwd, includeLayers: false });
    const rpc = this.connect(mcpOverrides(config));
    try {
      await this.ready(rpc);
      const checked = await rpc.call('config/read', { cwd, includeLayers: false });
      assertChatConfig(checked.config);
      if (login) {
        const account = await rpc.call('account/read', { refreshToken: false });
        if (account.account?.type !== 'chatgpt') throw Error('请先在本机 Codex 中使用 ChatGPT 登录');
      }
      return rpc;
    } catch (error) {
      rpc.close();
      throw error;
    }
  }

  options(cwd) {
    return {
      cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      modelProvider: 'openai',
      baseInstructions: instructions,
      developerInstructions: '',
    };
  }

  verifyStart(started, cwd, id) {
    verifyThread(started.thread, cwd, id);
    if (
      started.sandbox?.type !== 'readOnly' ||
      started.approvalPolicy !== 'never' ||
      started.modelProvider !== 'openai'
    )
      throw Error('Codex 未接受只读会话设置');
  }

  async fork(id) {
    const source = await this.selected(id);
    if (this.starting.has(id) || this.runs.get(id)?.status === 'running')
      throw Error('请等本轮回复结束再创建分支');
    const rpc = await this.worker(source.cwd, false);
    try {
      await this.scope(source.cwd);
      const result = await rpc.call(
        'thread/fork',
        {
          ...this.options(source.cwd),
          threadId: source.id,
          excludeTurns: true,
          deferGoalContinuation: true,
        },
        45000,
      );
      this.verifyStart(result, source.cwd);
      if (result.thread.id === source.id) throw Error('Codex 未返回新分支');
      if (source.projectId && result.thread.projectId !== source.projectId) {
        await rpc.call('thread/metadata/update', {
          threadId: result.thread.id,
          projectId: source.projectId,
        });
      }
      this.record.run(result.thread.id, source.cwd, source.id);
      return { id: result.thread.id };
    } finally {
      rpc.close();
    }
  }

  async index() {
    const roots = this.roots();
    const metadata = await readSessions(roots, { names: true });
    const rows = [...metadata.rows];
    for (const run of this.runs.values()) {
      if (!rows.some((row) => row.id === run.threadId) && (await sessionCwd(run.cwd, roots))) {
        rows.push({ id: run.threadId, cwd: run.cwd, name: '', updated: run.started });
      }
    }
    const directories = new Set();
    for (const dir of [
      ...roots.filter((root) => root.sessions).map((root) => root.path),
      ...rows.map((row) => row.cwd),
      ...this.board.snapshot.rows.filter((row) => !row.missing).map((row) => row.path),
    ]) {
      if (!directories.has(dir) && (await sessionCwd(dir, roots))) directories.add(dir);
    }
    return {
      status: metadata.status,
      reason: metadata.reason,
      directories: [...directories],
      sessions: rows
        .sort((a, b) => b.updated - a.updated)
        .map((row) => {
          const own = this.owned.get(row.id);
          return { ...row, owned: own?.cwd === row.cwd, parent: own?.parent || null };
        }),
    };
  }

  async selected(id) {
    const run = this.runs.get(id);
    if (run && !run.rpc.closed && (await sessionCwd(run.cwd, this.roots())))
      return { id, cwd: run.cwd, projectId: run.projectId };
    return lookupSession(id, this.roots());
  }

  async transcript(id, cursor, limit = historyPage) {
    if (cursor && cursor.length > 4096) throw Error('历史页游标无效');
    const selected = await this.selected(id);
    const rpc = await this.reader();
    const { thread } = await rpc
      .call('thread/read', { threadId: id, includeTurns: false })
      .catch((error) => {
        if (this.runs.has(id)) return { thread: null };
        throw error;
      });
    let messages = [],
      nextCursor = null;
    if (thread) {
      verifyThread(thread, selected.cwd, id);
      if (thread.path) await assertRollout(thread.path);
      await this.scope(selected.cwd);
      if (thread.historyMode === 'legacy') {
        const legacy = await rpc.call('thread/read', { threadId: id, includeTurns: true });
        messages = visibleMessages(legacy.thread.turns || []);
      } else {
        const page = await rpc.call('thread/turns/list', {
          threadId: id,
          cursor: cursor || null,
          limit,
          sortDirection: 'desc',
          itemsView: 'full',
        });
        messages = visibleMessages([...page.data].reverse());
        nextCursor = page.nextCursor || null;
      }
    }
    // A just-started native thread can be absent from the index until its first turn is saved.
    await this.scope(selected.cwd);
    const own = this.owned.get(id);
    return {
      id,
      cwd: selected.cwd,
      name: thread?.name || '',
      model: thread?.model || '',
      owned: own?.cwd === selected.cwd,
      parent: own?.parent || null,
      messages,
      cursor: nextCursor,
      run: runView(this.runs.get(id)),
    };
  }

  async status(id) {
    const run = this.runs.get(id);
    if (run) await this.scope(run.cwd);
    return runView(run);
  }

  send(input) {
    if (typeof input.requestId !== 'string' || !/^[\da-f-]{36}$/i.test(input.requestId))
      throw Error('发送请求编号无效');
    if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 16000)
      throw Error('请输入消息，最多 16,000 个字符');
    const key = input.threadId || input.requestId;
    if (this.requests.has(input.requestId)) throw Error('这条消息已经提交，请回到对应对话查看');
    if (this.starting.has(key) || this.runs.get(key)?.status === 'running')
      throw Error('这条对话正在生成回复');
    this.starting.add(key);
    this.requests.set(input.requestId, true);
    const retention = setTimeout(() => this.requests.delete(input.requestId), 30 * 60000);
    retention.unref();
    return this.start(input).finally(() => this.starting.delete(key));
  }

  async start(input) {
    const from = input.threadId ? await this.selected(input.threadId) : null;
    const cwd = await this.scope(from?.cwd || input.cwd);
    let projectId = from?.projectId || null;
    if (!from && input.projectId) {
      if (typeof input.projectId !== 'string') throw Error('Codex 项目 ID 无效');
      const reader = await this.reader();
      const { project } = await reader.call('project/read', { projectId: input.projectId });
      if (
        project?.id !== input.projectId ||
        !project.roots.some((root) => inside(systemPath(root.path), cwd))
      )
        throw Error('对话目录不属于指定的 Codex 项目');
      projectId = project.id;
    }
    const rpc = await this.worker(cwd);
    let run;
    try {
      await this.scope(cwd);
      const options = this.options(cwd);
      const started = await (from
        ? rpc.call('thread/resume', { ...options, threadId: from.id, excludeTurns: true }, 45000)
        : rpc.call('thread/start', { ...options, ephemeral: false, ...(projectId && { projectId }) }));
      this.verifyStart(started, cwd, from?.id);
      if (!from && projectId && started.thread.projectId !== projectId)
        throw Error('Codex 未将新对话挂到指定项目');
      const id = started.thread.id;
      if (!from) this.record.run(id, cwd, null);
      const user = { id: input.requestId, role: 'user', text: input.message.trim() };
      run = {
        threadId: id,
        projectId,
        cwd,
        started: Date.now(),
        model: started.model,
        rpc,
        status: 'running',
        turnId: '',
        messages: new Map([[user.id, user]]),
      };
      this.runs.set(id, run);
      rpc.on('notification', (method, event) => this.onEvent(run, method, event));
      rpc.on('closed', () => this.finish(run, 'failed', 'Codex 连接已断开，请查看已保存的回复'));
      run.deadline = setTimeout(
        () => this.finish(run, 'failed', '此轮等待超时，请查看已保存的回复'),
        12 * 60000,
      );
      run.deadline.unref();
      await this.scope(cwd);
      const { turn } = await rpc.call(
        'turn/start',
        {
          cwd,
          threadId: id,
          clientUserMessageId: user.id,
          input: [{ type: 'text', text: user.text, text_elements: [] }],
          approvalPolicy: 'never',
          sandboxPolicy: sandbox,
        },
        45000,
      );
      run.turnId ||= turn.id;
      return runView(run);
    } catch (error) {
      if (run) this.finish(run, 'failed', error.message);
      else rpc.close();
      throw error;
    }
  }

  onEvent(run, method, event) {
    if (event.threadId !== run.threadId || run.status !== 'running') return;
    if (run.turnId && event.turnId && event.turnId !== run.turnId) return;
    if (method === 'turn/started') run.turnId ||= event.turn?.id;
    if (method === 'item/agentMessage/delta') {
      const old = run.messages.get(event.itemId);
      run.messages.set(event.itemId, {
        id: event.itemId,
        role: 'assistant',
        text: (old?.text || '') + event.delta,
      });
    }
    if (method === 'item/completed' && event.item?.type === 'agentMessage') {
      const message = messageItem(event.item);
      if (message) run.messages.set(message.id, message);
    }
    if (method === 'turn/completed' && (!run.turnId || run.turnId === event.turn.id)) {
      for (const message of visibleMessages([event.turn])) {
        if (message.role === 'assistant') run.messages.set(message.id, message);
      }
      const status = event.turn.status;
      const error = event.turn.error?.message
        ? /rate.limit|quota|usage.limit|429/i.test(event.turn.error.message)
          ? 'Codex 当前达到使用限制，请稍后重试'
          : /401|unauthoriz|missing scopes/i.test(event.turn.error.message)
            ? 'Codex 登录验证未通过，请检查本机 ChatGPT 登录'
            : 'Codex 未能完成回复，可查看已生成的内容'
        : '';
      this.finish(run, status, error);
    }
  }

  finish(run, status, error = '') {
    if (run.status !== 'running') return;
    run.status = status;
    run.error = error;
    clearTimeout(run.deadline);
    setTimeout(() => run.rpc.close(), 400).unref();
    setTimeout(() => {
      if (this.runs.get(run.threadId) === run) this.runs.delete(run.threadId);
    }, 5 * 60000).unref();
  }

  async interrupt(id) {
    const run = this.runs.get(id);
    if (!run || run.status !== 'running' || !run.turnId) return runView(run);
    await this.scope(run.cwd);
    await run.rpc.call('turn/interrupt', { threadId: id, turnId: run.turnId }, 10000);
    return runView(run);
  }

  async revoke() {
    for (const run of this.runs.values()) {
      if (await sessionCwd(run.cwd, this.roots())) continue;
      if (run.status === 'running') this.finish(run, 'interrupted');
      this.runs.delete(run.threadId);
    }
  }

  close() {
    for (const rpc of this.workers) rpc.close(true);
  }
}
