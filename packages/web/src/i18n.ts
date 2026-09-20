export type Locale = "en" | "zh-CN";

const chinese: Record<string, string> = {
  "Files": "文件", "Edit": "编辑", "Preview": "预览", "Comments": "评论",
  "Split": "分栏", "Vault": "文档库", "Discover": "发现", "Suggestions": "修改建议",
  "Comment": "评论", "Authors": "作者", "Suggesting": "建议模式", "Snapshot": "快照",
  "Share": "分享", "Export": "导出", "Display": "显示", "Linked from": "反向链接",
  "Agent contributions": "智能体贡献", "Search the vault": "搜索文档库",
  "Search files and contents": "搜索文件和内容", "Connect agent": "连接智能体",
  "Language": "语言", "Client": "客户端", "Platform": "平台", "Configuration": "配置",
  "Copy configuration": "复制配置", "Sample task": "示例任务", "Copy task": "复制任务",
  "Copied": "已复制", "Copy failed": "复制失败", "Close": "关闭",
  "No agent in this document": "此文档暂无智能体", "Agent connected": "智能体已连接",
  "No document selected": "未选择文档", "Connection unavailable": "连接不可用",
  "Localhost session required": "需要本机 localhost 会话",
  "live": "已连接", "offline": "离线", "connecting": "连接中",
  "server unreachable": "无法连接服务器", "Accept": "接受", "Reject": "拒绝",
  "Show": "定位", "Assign": "分配", "Unassign": "取消分配", "Resolve": "解决",
  "Reopen": "重新打开", "Delete": "删除", "agent": "智能体",
  "No matching documents.": "没有匹配的文档。", "No Markdown files.": "没有 Markdown 文件。",
  "Nothing awaiting review.": "暂无待审核的修改。", "No comments yet.": "暂无评论。",
  "proposes": "提出修改", "Revert edits": "撤销修改", "Theme": "主题", "Reading": "阅读",
  "Prose": "正文", "Editor": "编辑器", "Size": "字号", "Leading": "行高", "Width": "行宽",
};

export function resolveLocale(saved: string | null, languages: readonly string[]): Locale {
  if (saved === "en" || saved === "zh-CN") return saved;
  // Do not silently substitute Simplified Chinese for Traditional Chinese preferences.
  return languages[0]?.match(/^zh(?:-CN|-SG|-Hans(?:-.+)?)?$/i) ? "zh-CN" : "en";
}

let locale: Locale = "en";
export function getLocale(): Locale { return locale; }
export function t(key: string): string { return locale === "zh-CN" ? chinese[key] ?? key : key; }

export function applyTranslations(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n]")) el.textContent = t(el.dataset.i18n!);
  for (const attr of ["title", "aria-label", "placeholder"]) {
    for (const el of root.querySelectorAll<HTMLElement>(`[data-i18n-${attr}]`)) {
      el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`)!));
    }
  }
}

export function setLocale(next: Locale): void {
  locale = next;
  try { localStorage.setItem("quire:locale", next); } catch { /* Optional preference storage. */ }
  document.documentElement.lang = next;
  applyTranslations();
  window.dispatchEvent(new Event("quire:locale"));
}

export function initLocale(): void {
  // Bind only application chrome, never filenames, editor content or rendered Markdown.
  for (const el of document.querySelectorAll<HTMLElement>(
    "#compact-nav button, .mode, #document-views button, .tool span, #rail h2, #backlinks-panel h2",
  )) {
    for (const node of [...el.childNodes]) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
      const label = document.createElement("span");
      label.dataset.i18n = node.textContent.trim();
      label.textContent = node.textContent;
      node.replaceWith(label);
    }
  }
  const search = document.querySelector<HTMLInputElement>("#search");
  if (search) {
    search.setAttribute("data-i18n-placeholder", "Search the vault");
    search.setAttribute("data-i18n-aria-label", "Search files and contents");
  }
  let saved: string | null = null;
  try { saved = localStorage.getItem("quire:locale"); } catch { /* Storage may be disabled. */ }
  locale = resolveLocale(saved, navigator.languages);
  document.documentElement.lang = locale;
  applyTranslations();
}
