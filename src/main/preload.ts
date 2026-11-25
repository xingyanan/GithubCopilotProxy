import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("api", {
  invoke: async (method: string, ...args: unknown[]) => {
    const r = await ipcRenderer.invoke("invoke", method, ...args);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  },
  onState: (cb: (s: unknown) => void) => {
    const h = (_: unknown, s: unknown) => cb(s);
    ipcRenderer.on("state", h);
    return () => ipcRenderer.off("state", h);
  },
  platform: process.platform,
});
