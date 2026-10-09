/**
 * Host ↔ Client command channel. The Host cannot reach the Electron <webview>, so each tool call
 * becomes a command a Desktop window long-polls, executes against its sidebar browser, and answers.
 */
import { randomUUID } from 'node:crypto';

export class BrowserUseError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const POLL_HOLD_MS = 5_000;
/** A window that polled this recently counts as connected even while it is between polls. */
const CLIENT_FRESH_MS = 40_000;

export function createBridge({ now = () => Date.now(), holdMs = POLL_HOLD_MS } = {}) {
  const queue = [];                 // commands no window has taken yet
  const waiters = [];               // parked polls: { resolve }
  const inflight = new Map();       // id → { resolve, reject, timer, command }
  let lastPollAt = 0;

  function hand(command) {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(command); else queue.push(command);
  }

  function settle(id, outcome) {
    const entry = inflight.get(id);
    if (entry === undefined) return false;
    inflight.delete(id);
    clearTimeout(entry.timer);
    const index = queue.indexOf(entry.command);
    if (index !== -1) queue.splice(index, 1);
    if (outcome.ok) entry.resolve(outcome.value); else entry.reject(new BrowserUseError(outcome.error ?? '浏览器操作失败', 502));
    return true;
  }

  return {
    connected: () => waiters.length > 0 || now() - lastPollAt < CLIENT_FRESH_MS,

    /**
     * Send one command to a Desktop window and wait for its answer.
     * @param command - { action, args, sessionId }.
     * @param options.timeoutMs - total budget, including time in the queue.
     */
    request(command, { timeoutMs = 30_000, signal } = {}) {
      if (!this.connected()) {
        return Promise.reject(new BrowserUseError('没有已连接的 DSH 桌面窗口：浏览器操作只在 DeepSeek Harness 桌面版中可用，请确认窗口已打开（Web 版的 iframe 无法被控制）。', 503));
      }
      const full = { ...command, id: randomUUID() };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => settle(full.id, { ok: false, error: `浏览器在 ${Math.round(timeoutMs / 1000)} 秒内没有响应（${command.action}）` }), timeoutMs);
        inflight.set(full.id, { resolve, reject, timer, command: full });
        signal?.addEventListener('abort', () => settle(full.id, { ok: false, error: '已取消' }), { once: true });
        hand(full);
      });
    },

    /** A window asks for work; resolves with a command or undefined after the hold time. */
    poll(signal) {
      lastPollAt = now();
      if (queue.length > 0) return Promise.resolve(queue.shift());
      return new Promise((resolve) => {
        const waiter = {
          resolve: (command) => { clearTimeout(timer); resolve(command); },
        };
        const release = () => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          lastPollAt = now();
          resolve(undefined);
        };
        const timer = setTimeout(release, holdMs);
        signal?.addEventListener('abort', () => { clearTimeout(timer); release(); }, { once: true });
        waiters.push(waiter);
      });
    },

    /** Deliver a window's answer; false when the command already timed out or was cancelled. */
    answer(id, outcome) { return settle(id, outcome); },

    dispose() {
      for (const id of [...inflight.keys()]) settle(id, { ok: false, error: '插件已卸载' });
      for (const waiter of waiters.splice(0)) waiter.resolve(undefined);
    },
  };
}
