// 将渲染进程的静态资源（html/css）复制到 dist/renderer
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src", "renderer");
const out = join(root, "dist", "renderer");
mkdirSync(out, { recursive: true });
for (const f of readdirSync(src)) {
  if (f.endsWith(".html") || f.endsWith(".css")) cpSync(join(src, f), join(out, f));
}
console.log("static assets copied ->", out);
