/** SSE 工具：解析上游流、生成下游事件 */

export interface SSEEvent {
  event?: string;
  data: string;
}

/** 将 fetch 的 ReadableStream 解析为 SSE 事件序列 */
export async function* parseSSE(body: ReadableStream<Uint8Array> | null): AsyncGenerator<SSEEvent> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event: string | undefined;
  let data: string[] = [];
  const flush = (): SSEEvent | undefined => {
    if (data.length === 0 && !event) return undefined;
    const e = { event, data: data.join("\n") };
    event = undefined;
    data = [];
    return e;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          const e = flush();
          if (e) yield e;
          continue;
        }
        if (line.startsWith(":")) continue;
        const idx = line.indexOf(":");
        const field = idx < 0 ? line : line.slice(0, idx);
        let val = idx < 0 ? "" : line.slice(idx + 1);
        if (val.startsWith(" ")) val = val.slice(1);
        if (field === "event") event = val;
        else if (field === "data") data.push(val);
      }
    }
    buf += decoder.decode();
    if (buf.trim()) {
      for (const line of buf.split(/\r?\n/)) {
        if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        else if (line.startsWith("event:")) event = line.slice(6).trim();
      }
    }
    const e = flush();
    if (e) yield e;
  } finally {
    reader.releaseLock?.();
  }
}

/** 解析 JSON data（忽略 [DONE] 与无法解析的行） */
export async function* parseSSEJson(body: ReadableStream<Uint8Array> | null): AsyncGenerator<{ event?: string; json: any }> {
  for await (const e of parseSSE(body)) {
    if (!e.data || e.data === "[DONE]") continue;
    try {
      yield { event: e.event, json: JSON.parse(e.data) };
    } catch {
      /* 忽略 */
    }
  }
}

export const sseData = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
export const sseEvent = (event: string, obj: unknown) => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;
