/** One searchable control (or list) of a Settings page. */
export type SettingEntry = {
  id: string; // "terminal.fontSize"; unique; [a-zA-Z0-9.]+
  section: string; // a SECTIONS id
  titleKey: string; // i18n key the page already shows
  descriptionKey?: string;
  keywords: readonly string[]; // English and Vietnamese words, lower case
};

const e = (id: string, titleKey: string, keywords: string[], descriptionKey?: string): SettingEntry => ({
  id,
  section: id.slice(0, id.indexOf(".")),
  titleKey,
  keywords,
  ...(descriptionKey ? { descriptionKey } : {}),
});

/**
 * Every control of every page, in page order. A control a page shows without an entry here fails
 * the coverage test (SettingRow.test.tsx). Keywords carry both English and Vietnamese words: the
 * search does not fold diacritics.
 */
export const SETTING_ENTRIES: readonly SettingEntry[] = [
  // General
  e("general.tabOrder", "settings.general.tabOrder", ["ctrl+tab", "tab", "order", "recent", "mru", "thứ tự", "thu tu", "gần đây", "gan day"], "settings.general.tabOrderHint"),
  e("general.nav.confirmClosePinned", "settings.general.confirmClosePinned", ["close", "pinned", "confirm", "đóng", "dong", "ghim", "xác nhận", "xac nhan"]),
  e("general.nav.confirmCloseRunning", "settings.general.confirmCloseRunning", ["close", "running", "agent", "process", "confirm", "đóng", "dong", "đang chạy", "dang chay", "xác nhận", "xac nhan"], "settings.general.confirmCloseRunningHint"),
  e("general.nav.askBeforeDeleteWorktree", "settings.general.askBeforeDeleteWorktree", ["delete", "remove", "worktree", "ask", "confirm", "xoá", "xoa", "xóa", "hỏi", "hoi"]),
  e("general.zoom", "settings.general.zoom", ["zoom", "scale", "size", "thu phóng", "thu phong", "phóng to", "phong to"]),
  e("general.restore", "layout.setting", ["restore", "layout", "session", "reopen", "khôi phục", "khoi phuc", "bố cục", "bo cuc"], "layout.setting.hint"),
  e("general.openIn", "settings.general.openIn", ["open in", "apps", "ide", "mở bằng", "mo bang", "ứng dụng", "ung dung"]),
  e("general.diffView", "settings.general.diffView", ["diff", "inline", "split", "side by side", "view", "chế độ", "che do", "tách", "tach"]),
  e("general.diff.ignoreWhitespace", "settings.general.ignoreWhitespace", ["diff", "whitespace", "space", "khoảng trắng", "khoang trang"]),
  e("general.diff.collapseUnchanged", "settings.general.collapseUnchanged", ["diff", "collapse", "unchanged", "thu gọn", "thu gon"]),
  e("general.diff.wordWrap", "settings.general.wordWrap", ["diff", "wrap", "long lines", "xuống dòng", "xuong dong"]),
  e("general.diff.fileTree", "settings.general.fileTree", ["diff", "file tree", "tree", "cây", "cay", "tệp", "tep"], "settings.general.fileTreeHint"),
  // Agents
  e("agents.approvals", "settings.agents.approvals", ["permission", "ask", "skip", "yolo", "phê duyệt", "phe duyet", "quyền", "quyen"]),
  e("agents.defaultAgent", "settings.agents.defaultAgent", ["default", "agent", "mặc định", "mac dinh"]),
  e("agents.defaultShell", "settings.agents.defaultShell", ["default", "shell", "mặc định", "mac dinh"]),
  e("agents.profiles", "settings.agents.profiles", ["claude", "codex", "gemini", "profile", "enable", "hồ sơ", "ho so"]),
  e("agents.shells", "settings.agents.shells", ["shell", "bash", "powershell", "zsh", "program", "args"]),
  e("agents.statusHooks", "settings.agents.statusHooks.label", ["hooks", "status", "trạng thái", "trang thai"], "settings.agents.statusHooks.what"),
  // Notifications
  e("notifications.enabled", "settings.notifications.enabled", ["notify", "alert", "master", "thông báo", "thong bao"], "settings.notifications.enabledHint"),
  e("notifications.onNeedsInput", "settings.notifications.onNeedsInput", ["input", "waiting", "cần nhập", "can nhap"], "settings.notifications.onNeedsInputHint"),
  e("notifications.onDone", "settings.notifications.onDone", ["finish", "complete", "xong", "hoàn thành", "hoan thanh"], "settings.notifications.onDoneHint"),
  e("notifications.onFailed", "settings.notifications.onFailed", ["error", "fail", "lỗi", "loi"], "settings.notifications.onFailedHint"),
  e("notifications.onBell", "settings.notifications.onBell", ["bell", "chuông", "chuong"], "settings.notifications.onBellHint"),
  e("notifications.suppressWhenFocused", "settings.notifications.suppressWhenFocused", ["focus", "quiet", "tiêu điểm", "tieu diem"], "settings.notifications.suppressWhenFocusedHint"),
  e("notifications.channels", "settings.notifications.channels", ["os", "sound", "bell", "badge", "âm thanh", "am thanh"], "settings.notifications.channelsHint"),
  e("notifications.sound", "settings.notifications.soundGroup", ["volume", "beep", "âm lượng", "am luong", "tiếng", "tieng"], "settings.notifications.soundFileHint"),
  // Terminal
  e("terminal.fontFamily", "settings.terminal.fontFamily", ["font", "typeface", "phông", "phong", "chữ", "chu"], "settings.terminal.fontFamilyHint"),
  e("terminal.fontSize", "settings.terminal.fontSize", ["font", "zoom", "cỡ chữ", "co chu", "phông", "phong"]),
  e("terminal.fontWeight", "settings.terminal.fontWeight", ["font", "bold", "đậm", "dam"]),
  e("terminal.lineHeight", "settings.terminal.lineHeight", ["spacing", "dòng", "dong", "giãn", "gian"]),
  e("terminal.cursorStyle", "settings.terminal.cursorStyle", ["cursor", "block", "bar", "underline", "con trỏ", "con tro"]),
  e("terminal.cursorBlink", "settings.terminal.cursorBlink", ["cursor", "blink", "nhấp nháy", "nhap nhay"]),
  e("terminal.scrollback", "settings.terminal.scrollback", ["buffer", "history", "lines", "lịch sử", "lich su"], "settings.terminal.scrollbackHint"),
  e("terminal.copyOnSelect", "settings.terminal.copyOnSelect", ["clipboard", "copy", "select", "sao chép", "sao chep"]),
  e("terminal.rightClickPaste", "settings.terminal.rightClickPaste", ["clipboard", "paste", "mouse", "dán", "dan"]),
  e("terminal.osc52Clipboard", "settings.terminal.osc52Clipboard", ["clipboard", "osc52", "osc 52"], "settings.terminal.osc52ClipboardHint"),
  e("terminal.service", "settings.terminal.service.label", ["service", "daemon", "background", "keep running", "quit", "dịch vụ", "dich vu", "chạy nền", "chay nen"], "settings.terminal.service.hint"),
  e("terminal.onQuit", "settings.terminal.service.onQuit", ["quit", "close", "exit", "end", "ask", "thoát", "thoat", "đóng", "dong"]),
  e("terminal.ringMb", "settings.terminal.service.ringMb", ["ring", "buffer", "output", "memory", "bộ nhớ", "bo nho"], "settings.terminal.service.ringMbHint"),
  e("terminal.running", "settings.terminal.service.running", ["running", "service", "end", "restart", "đang chạy", "dang chay", "khởi động lại", "khoi dong lai"]),
  e("terminal.reset", "settings.terminal.reset", ["defaults", "reset", "đặt lại", "dat lai"]),
  // Editor
  e("editor.autosave", "files.settings.autosave", ["save", "tự động lưu", "tu dong luu"], "files.settings.autosaveHint"),
  e("editor.wordWrap", "files.settings.wordWrap", ["wrap", "xuống dòng", "xuong dong"]),
  e("editor.autosaveMs", "files.settings.autosaveMs", ["save", "delay", "milliseconds", "độ trễ", "do tre"]),
  e("editor.fontSize", "files.settings.fontSize", ["font", "cỡ chữ", "co chu", "phông", "phong"]),
  e("editor.tabSize", "files.settings.tabSize", ["tab", "indent", "thụt lề", "thut le"], "files.settings.tabSizeHint"),
  // Repositories (the same fields on every repo card)
  e("repos.shortName", "settings.repos.shortName", ["name", "repo", "tên", "ten"], "settings.repos.shortNameNote"),
  e("repos.baseRef", "settings.repos.baseRef", ["base", "branch", "main", "nhánh", "nhanh"], "settings.repos.baseRefHint"),
  e("repos.worktreeRoot", "settings.repos.worktreeRoot", ["folder", "directory", "path", "thư mục", "thu muc"], "settings.repos.worktreeRootHint"),
  e("repos.scriptPolicy", "settings.repos.scripts.policy", ["setup", "script", "run", "kịch bản", "kich ban"]),
  e("repos.scriptSource", "settings.repos.scripts.source", ["setup", "script", "shared", "local", "kịch bản", "kich ban"]),
  e("repos.localScripts", "settings.repos.scripts", ["setup", "archive", "script", "kịch bản", "kich ban"], "settings.repos.scripts.localHint"),
  e("repos.repoFile", "settings.repos.file", ["xdev.toml", "shared", "tabs", "unknown", "node_modules", "tab mặc định", "tab mac dinh"], "settings.repos.file.hint"),
  e("repos.sharedScripts", "settings.repos.scripts.shared", ["trust", "script", "tin cậy", "tin cay"], "settings.repos.scripts.trustNote"),
  // Open in
  e("openIn.apps", "openIn.title", ["editor", "vscode", "app", "command", "args", "mở bằng", "mo bang"], "openIn.intro"),
  // Git
  e("git.prefix", "settings.git.prefix", ["branch", "name", "username", "nhánh", "nhanh", "tiền tố", "tien to"]),
  e("git.compare", "settings.git.compare", ["diff", "upstream", "base", "so sánh", "so sanh"], "settings.git.compareHint"),
  e("git.refresh", "settings.git.refresh", ["fetch", "pull", "base", "create", "làm mới", "lam moi"], "settings.git.refreshHint"),
  e("git.ai", "settings.git.ai.show", ["ai", "commit", "message", "source control"], "settings.git.ai.showHint"),
  e("git.pr", "settings.git.pr.title", ["pull request", "draft", "pr"]),
  // Vaults
  e("vaults.repo", "settings.vaults.repo", ["docs", "notes", "repo", "tài liệu", "tai lieu"]),
  e("vaults.shared", "settings.vaults.shared", ["docs", "notes", "add", "forget", "folder", "tài liệu", "tai lieu", "chia sẻ", "chia se"]),
  // Shortcuts and quick commands: the page keeps its own list search, so one entry each.
  e("keys.page", "keys.title", ["shortcut", "keybinding", "hotkey", "chord", "phím tắt", "phim tat"]),
  e("qcmd.page", "qcmd.title", ["quick", "command", "script", "alias", "lệnh nhanh", "lenh nhanh"]),
];

/** The longest query searched, in bytes after trim; longer input is cut. */
export const QUERY_MAX = 2048;

export type SettingHit = { entry: SettingEntry; score: number };

// exact / prefix / contains of the text, or 0
function grade(text: string, q: string, [exact, prefix, contains]: readonly [number, number, number]): number {
  const x = text.toLowerCase();
  if (x === q) return exact;
  if (x.startsWith(q)) return prefix;
  return x.includes(q) ? contains : 0;
}

/** The query as searched: trimmed, lower case, at most QUERY_MAX bytes (cut on a character edge). */
function normalize(query: string): string {
  let q = query.trim().toLowerCase();
  const enc = new TextEncoder();
  while (q.length > 0 && enc.encode(q).length > QUERY_MAX) q = q.slice(0, Math.max(0, q.length - Math.ceil((enc.encode(q).length - QUERY_MAX) / 3)));
  return q.trim();
}

/**
 * Entries that match, best first. A section title match counts for every entry of that section.
 * An empty query returns every entry with score 0, in catalog order. No diacritic folding.
 */
export function searchSettings(
  query: string,
  entries: readonly SettingEntry[],
  t: (key: string) => string,
  sectionTitle: (section: string) => string,
): SettingHit[] {
  const q = normalize(query);
  if (!q) return entries.map((entry) => ({ entry, score: 0 }));
  const hits: (SettingHit & { at: number })[] = [];
  entries.forEach((entry, at) => {
    const score = Math.max(
      grade(sectionTitle(entry.section), q, [900, 850, 800]),
      grade(t(entry.titleKey), q, [700, 650, 600]),
      entry.descriptionKey ? grade(t(entry.descriptionKey), q, [500, 450, 400]) : 0,
      ...entry.keywords.map((k) => grade(k, q, [300, 250, 200])),
    );
    if (score > 0) hits.push({ entry, score, at });
  });
  hits.sort((a, b) => b.score - a.score || a.at - b.at);
  return hits.map(({ entry, score }) => ({ entry, score }));
}
