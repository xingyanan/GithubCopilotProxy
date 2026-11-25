import { EventEmitter } from "node:events";
import type { LogEntry } from "../shared/types";

/** 请求日志环形缓冲 + 统计 */
export class RequestLog extends EventEmitter {
  private entries: LogEntry[] = [];
  private seq = 0;
  stats = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0 };

  constructor(private capacity = 500) { super(); }

  begin(method: string, path: string): LogEntry {
    const e: LogEntry = { id: ++this.seq, time: Date.now(), method, path };
    return e;
  }

  finish(e: LogEntry) {
    e.durationMs = Date.now() - e.time;
    this.stats.requests++;
    if ((e.status ?? 0) >= 400 || e.error) this.stats.errors++;
    this.stats.inputTokens += e.inputTokens ?? 0;
    this.stats.outputTokens += e.outputTokens ?? 0;
    this.entries.push(e);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    this.emit("entry", e);
  }

  list(): LogEntry[] { return this.entries.slice(); }

  clear() {
    this.entries = [];
    this.stats = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0 };
    this.emit("cleared");
  }
}

export const debug = (...args: unknown[]) => {
  if (process.env.COPILOT_PROXY_DEBUG) console.error("[copilot-proxy]", ...args);
};
