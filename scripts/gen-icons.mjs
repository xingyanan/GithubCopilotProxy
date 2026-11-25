// 生成应用图标与托盘图标（纯 Node 实现的 PNG 编码，无第三方依赖）
// 用法: node scripts/gen-icons.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "assets");
mkdirSync(outDir, { recursive: true });

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// 超采样绘制：圆角方块 + "飞行员护目镜"(两个圆眼)
function shape(variant) {
  return (x, y, size) => {
    const SS = 4;
    let acc = [0, 0, 0, 0];
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const u = (x + (sx + 0.5) / SS) / size;
      const v = (y + (sy + 0.5) / SS) / size;
      const c = sample(u, v, variant);
      for (let i = 0; i < 4; i++) acc[i] += c[i];
    }
    return acc.map((n) => Math.round(n / (SS * SS)));
  };
}
function inRoundRect(u, v, pad, r) {
  const x = Math.min(Math.max(u, pad + r), 1 - pad - r);
  const y = Math.min(Math.max(v, pad + r), 1 - pad - r);
  return (u - x) ** 2 + (v - y) ** 2 <= r * r;
}
function sample(u, v, variant) {
  const eyeL = (u - 0.33) ** 2 + (v - 0.5) ** 2;
  const eyeR = (u - 0.67) ** 2 + (v - 0.5) ** 2;
  const ringOuter = 0.17 ** 2, ringInner = 0.1 ** 2, pupil = 0.045 ** 2;
  const bridge = Math.abs(v - 0.47) < 0.035 && u > 0.45 && u < 0.55;
  const ring = (d) => d <= ringOuter && d >= ringInner;
  if (variant === "tray") {
    // 托盘：透明背景 + 深色护目镜，Windows/Linux 浅深色栏都可见
    if (ring(eyeL) || ring(eyeR) || bridge) return [40, 44, 52, 255];
    if (eyeL < pupil || eyeR < pupil) return [40, 44, 52, 255];
    if (inRoundRect(u, v, 0.02, 0.2)) return [124, 92, 255, 255];
    return [0, 0, 0, 0];
  }
  if (!inRoundRect(u, v, 0.04, 0.22)) return [0, 0, 0, 0];
  // 背景渐变: 紫 -> 蓝
  const t = (u + v) / 2;
  const bg = [Math.round(124 * (1 - t) + 37 * t), Math.round(92 * (1 - t) + 99 * t), Math.round(255 * (1 - t) + 235 * t), 255];
  if (ring(eyeL) || ring(eyeR) || bridge) return [255, 255, 255, 255];
  if (eyeL < pupil || eyeR < pupil) return [255, 255, 255, 255];
  return bg;
}

writeFileSync(join(outDir, "icon.png"), png(256, shape("app")));
writeFileSync(join(outDir, "tray.png"), png(16, shape("tray")));
writeFileSync(join(outDir, "tray@2x.png"), png(32, shape("tray")));
// 代理停止时的灰色托盘图标：背景变灰、护目镜保持深色
const gray = (x, y, s) => {
  const c = shape("tray")(x, y, s);
  if (!c[3]) return c;
  const l = Math.round(c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11);
  return [l + 20, l + 20, l + 20, c[3]];
};
writeFileSync(join(outDir, "tray-off.png"), png(16, gray));
writeFileSync(join(outDir, "tray-off@2x.png"), png(32, gray));
console.log("icons written ->", outDir);
