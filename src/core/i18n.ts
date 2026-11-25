/** 极简双语支持：L("中文", "English") 按当前语言返回对应文案 */
export type Lang = "zh" | "en";

let current: Lang = "zh";

export function setLang(lang: Lang) { current = lang; }
export function getLang(): Lang { return current; }
export const L = (zh: string, en: string) => (current === "en" ? en : zh);

/** 把 "auto" 解析为具体语言 */
export function resolveLang(setting: string | undefined, systemLocale: string | undefined): Lang {
  if (setting === "zh" || setting === "en") return setting;
  return (systemLocale ?? "").toLowerCase().startsWith("zh") ? "zh" : "en";
}
