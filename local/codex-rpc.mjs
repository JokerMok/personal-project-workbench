import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';

const installed =
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const binary = process.env.WORKBENCH_CODEX_BIN || (existsSync(installed) ? installed : 'codex');
const officialChat = 'https://chatgpt.com/backend-api/';
const disabledFeatures = [
  'shell_tool',
  'unified_exec',
  'shell_snapshot',
  'apps',
  'plugins',
  'hooks',
  'multi_agent',
  'multi_agent_v2',
  'goals',
  'in_app_browser',
  'skill_mcp_dependency_install',
];
const baseArgs = [
  'app-server',
  '--listen',
  'stdio://',
  '-c',
  'approval_policy="never"',
  '-c',
  'sandbox_mode="read-only"',
  '-c',
  'web_search="disabled"',
  '-c',
  'model_provider="openai"',
  '-c',
  'project_doc_max_bytes=0',
  '-c',
  'chatgpt_base_url=' + JSON.stringify(officialChat),
  ...disabledFeatures.flatMap((name) => ['--disable', name]),
];

export class CodexRpc extends EventEmitter {
  constructor(cwd, overrides = []) {
    super();
    this.next = 0;
    this.pending = new Map();
    const env = { ...process.env };
    delete env.OPENAI_BASE_URL;
    delete env.OPENAI_API_KEY;
    this.child = spawn(binary, [...baseArgs, ...overrides], {
      cwd,
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.child.on('error', () => this.end('无法启动本机 Codex，请检查安装'));
    this.child.on('exit', () => this.end('本机 Codex 已断开'));
    this.child.stdin.on('error', () => this.end('本机 Codex 连接已关闭'));
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.method && msg.id !== undefined) {
        // The workbench does not grant tool, permission, or credential requests.
        this.write({ id: msg.id, error: { code: -32601, message: 'Unavailable in workbench chat' } });
      } else if (msg.method) {
        this.emit('notification', msg.method, msg.params || {});
      } else if (this.pending.has(msg.id)) {
        const current = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        current.settle(msg.error ? new CodexError(msg.error) : null, msg.result);
      }
    });
    this.ready = this.call('initialize', {
      clientInfo: { name: 'personal-project-workbench', title: '个人项目工作台', version: '1.1.0' },
      capabilities: { experimentalApi: true },
    }).then((result) => {
      this.write({ method: 'initialized' });
      return result;
    });
  }

  write(value) {
    if (!this.closed && this.child.stdin.writable) {
      this.child.stdin.write(JSON.stringify(value) + '\n');
    }
  }

  call(method, params, timeout = 20000) {
    if (this.closed) return Promise.reject(Error('本机 Codex 连接已关闭'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error('本机 Codex 请求超时，请查看会话后再重试'));
      }, timeout);
      this.pending.set(id, {
        settle(error, result) {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve(result);
        },
      });
      this.write({ id, method, params });
    });
  }

  end(reason) {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) request.settle(Error(reason));
    this.pending.clear();
    this.emit('closed');
  }

  close(force = false) {
    this.end('本机 Codex 连接已关闭');
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    if (force) {
      this.child.kill();
      return;
    }
    const timer = setTimeout(() => this.child.kill(), 1500);
    timer.unref();
    this.child.once('exit', () => clearTimeout(timer));
  }
}

export class CodexError extends Error {
  constructor(error) {
    const message = String(error.message || '');
    super(
      /writer.lock|lock.*thread|thread.*already.*(?:active|loaded|in use)|already.*writing|another.*process/i.test(
        message,
      )
        ? '此会话正在被 Codex 使用，请等当前回复完成后再试'
        : /login|unauthoriz|authenticat|sign in/i.test(message)
          ? '本机 Codex 需要登录，请在 Codex 中完成登录'
          : /rate.limit|quota|usage.limit|429/i.test(message)
            ? 'Codex 当前达到使用限制，请稍后重试'
            : '本机 Codex 未能处理该请求',
    );
    this.code = error.code;
    this.legacy = /legacy|not paginated|method not found/i.test(message) || error.code === -32601;
  }
}

export function mcpOverrides(config) {
  return Object.keys(config.mcp_servers || {}).flatMap((name) => {
    if (!/^[\w-]+$/.test(name)) throw Error('本机 Codex 连接器名称无法安全处理');
    return ['-c', 'mcp_servers.' + name + '.enabled=false'];
  });
}

export function assertChatConfig(config) {
  const features = config.features || {};
  if (
    config.model_provider !== 'openai' ||
    config.chatgpt_base_url !== officialChat ||
    !!config.openai_base_url ||
    config.approval_policy !== 'never' ||
    config.sandbox_mode !== 'read-only' ||
    config.web_search !== 'disabled' ||
    disabledFeatures.some((name) => features[name] !== false) ||
    Object.values(config.mcp_servers || {}).some((server) => server.enabled !== false)
  )
    throw Error('无法确认 Codex 的只读对话配置，请核对本机 Codex 设置');
}
