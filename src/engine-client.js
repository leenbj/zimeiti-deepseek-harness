/**
 * engine-client.js — 常驻 Python 浏览器引擎的 NDJSON/JSON-RPC 客户端。
 *
 * 契约见 docs/SPEC.md §2。这个模块不依赖 Cordis，可独立测试。
 *
 * 设计要点：
 *  - 懒启动：第一次 call() 时才 spawn 引擎进程。
 *  - 常驻：进程内可并发多个 session，不应为每次调用重启。
 *  - 自动重启：进程意外退出后，下一次 call() 会重新拉起；正在等待的请求收到 ENGINE_EXITED。
 *  - 事件：引擎会发无 id 的帧（progress / handoff），通过 EventEmitter 抛给上层。
 *  - stdout 只承载协议；stderr 全部当日志收集（环形缓冲，便于报错时附带尾部）。
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENGINE_ERROR_CODES = [
  'BAD_REQUEST', 'UNKNOWN_METHOD', 'SESSION_NOT_FOUND', 'TARGET_NOT_FOUND', 'TIMEOUT',
  'PROXY_UNAVAILABLE', 'LOGIN_REQUIRED', 'RECIPE_INVALID', 'PARAM_MISSING', 'UNSUPPORTED',
  'INTERNAL', 'ENGINE_EXITED', 'ENGINE_SPAWN_FAILED', 'ENGINE_TIMEOUT',
];

export class EngineError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.details = details;
  }
  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

const DEFAULTS = {
  pythonPath: undefined, // 必填（或从 config 传入）
  engineModule: 'engine.sessiond',
  pluginRoot: undefined,
  dataDir: undefined,
  requestTimeoutMs: 120_000,
  /** 单次调用里引擎最长静默时间；长任务（play.run）应显式传更大的 timeoutMs。 */
  stderrTailLines: 200,
};

export class EngineClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = { ...DEFAULTS, ...options };
    if (!this.options.pythonPath) throw new EngineError('INTERNAL', 'EngineClient 需要一个 pythonPath');
    if (!this.options.pluginRoot) throw new EngineError('INTERNAL', 'EngineClient 需要一个 pluginRoot');

    this.child = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject, timer, method}
    this.stdoutBuf = '';
    this.stderrTail = [];
    this.logPath = null;
    this.startPromise = null;
    this.exitedCount = 0;
  }

  get running() {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  /** 启动引擎进程（幂等）。并发调用共用同一个 promise。 */
  async start() {
    if (this.running) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = (async () => {
      const args = ['-u', '-m', this.options.engineModule];
      const env = {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      };
      if (this.options.dataDir) env.MEDIA_DATA_DIR = this.options.dataDir;

      let child;
      try {
        child = spawn(this.options.pythonPath, args, {
          cwd: this.options.pluginRoot,
          env,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        this.startPromise = null;
        throw new EngineError('ENGINE_SPAWN_FAILED', `无法启动引擎进程: ${error.message}`);
      }

      this.child = child;
      this._openLog();

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this._onStdout(chunk));
      child.stderr.on('data', (chunk) => this._onStderr(chunk));

      child.on('error', (error) => {
        this._failAllPending('ENGINE_SPAWN_FAILED', `引擎进程错误: ${error.message}`);
      });

      child.on('exit', (code, signal) => {
        const wasRunning = this.child === child;
        if (wasRunning) this.child = null;
        this.startPromise = null;
        this.exitedCount += 1;
        const detail = `引擎进程退出 (code=${code}, signal=${signal})` + this._stderrSuffix();
        this.emit('exit', { code, signal, tail: this._stderrSuffix() });
        this._failAllPending('ENGINE_EXITED', detail);
      });

      // 等一个极短窗口，确认没有立刻因语法/导入错误退出。
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (child.exitCode !== null) {
        this.startPromise = null;
        throw new EngineError(
          'ENGINE_SPAWN_FAILED',
          `引擎进程启动后立即退出 (code=${child.exitCode})` + this._stderrSuffix(),
        );
      }
    })();

    try {
      await this.startPromise;
    } finally {
      // 保留 startPromise 直到 running，避免并发重复 spawn；下次 start() 会因 running 提前返回。
      if (!this.running) this.startPromise = null;
    }
  }

  /**
   * 调用一个引擎方法。
   * @param {string} method 例如 "session.open"
   * @param {object} params
   * @param {{timeoutMs?: number}} [opts]
   */
  async call(method, params = {}, opts = {}) {
    await this.start();
    const id = this.nextId++;
    const timeoutMs = opts.timeoutMs ?? this.options.requestTimeoutMs;

    const line = JSON.stringify({ id, method, params }) + '\n';

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new EngineError('ENGINE_TIMEOUT', `${method} 在 ${timeoutMs}ms 内没有返回` + this._stderrSuffix()));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.child.stdin.write(line, 'utf8');
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new EngineError('ENGINE_EXITED', `写入引擎失败: ${error.message}`));
      }
    });
  }

  /** 优雅关闭：让引擎自行收尾（保存登录态、关浏览器）。 */
  async close({ timeoutMs = 15_000 } = {}) {
    const child = this.child;
    if (!child) return;
    this.child = null;
    try {
      child.stdin.end();
    } catch {
      /* 忽略 */
    }
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    if (child.exitCode === null) {
      try { child.kill(); } catch { /* 忽略 */ }
    }
    this._failAllPending('ENGINE_EXITED', '引擎已被主动关闭');
  }

  // ---- 内部 ----

  _onStdout(chunk) {
    this.stdoutBuf += chunk;
    let index;
    while ((index = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, index).replace(/\r$/, '');
      this.stdoutBuf = this.stdoutBuf.slice(index + 1);
      if (!line.trim()) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        // 引擎里混进来的非协议输出：当日志处理，绝不因此抛错。
        this._logLine(`[non-protocol stdout] ${line}`);
        continue;
      }
      this._onFrame(frame);
    }
  }

  _onFrame(frame) {
    if (frame && typeof frame === 'object' && frame.event) {
      this.emit('event', frame);
      this.emit(frame.event, frame.data ?? {});
      return;
    }
    const entry = this.pending.get(frame.id);
    if (!entry) {
      this._logLine(`[orphan frame] ${JSON.stringify(frame).slice(0, 500)}`);
      return;
    }
    this.pending.delete(frame.id);
    clearTimeout(entry.timer);
    if (frame.ok) {
      entry.resolve(frame.result);
    } else {
      const error = frame.error ?? {};
      entry.reject(new EngineError(error.code ?? 'INTERNAL', error.message ?? '引擎返回未知错误', error.details));
    }
  }

  _onStderr(chunk) {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line) this._logLine(line);
    }
  }

  _logLine(line) {
    this.stderrTail.push(line);
    if (this.stderrTail.length > this.options.stderrTailLines) {
      this.stderrTail.splice(0, this.stderrTail.length - this.options.stderrTailLines);
    }
    if (this.logPath) {
      try { appendFileSync(this.logPath, line + '\n', 'utf8'); } catch { /* 忽略 */ }
    }
    this.emit('log', line);
  }

  _stderrSuffix() {
    const tail = this.stderrTail.slice(-8);
    return tail.length ? `\n引擎日志尾部:\n${tail.join('\n')}` : '';
  }

  _openLog() {
    if (!this.options.dataDir || this.logPath) return;
    try {
      const dir = join(this.options.dataDir, 'logs');
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      this.logPath = join(dir, `engine-${stamp}.log`);
    } catch {
      this.logPath = null;
    }
  }

  _failAllPending(code, message) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new EngineError(code, message));
    }
    this.pending.clear();
  }
}

/**
 * Derive the default engine paths for a caller that has no configuration yet.
 * @param {{ pluginRoot?: string, pythonPath?: string, dataDir?: string }} [options]
 * @returns {{ pluginRoot: string, pythonPath: string, dataDir: string }}
 */
export function defaultEnginePaths({ pluginRoot, pythonPath, dataDir } = {}) {
  const root = pluginRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
  return {
    pluginRoot: root,
    pythonPath: pythonPath ?? process.env.MEDIA_PYTHON ?? '',
    dataDir: dataDir ?? process.env.MEDIA_DATA_DIR ?? join(root, 'data'),
  };
}
