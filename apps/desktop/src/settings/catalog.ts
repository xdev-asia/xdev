import { PLATFORM, type Platform } from "@/platform";

/** One searchable control (or list) of a Settings page. */
export type SettingEntry = {
  id: string; // "terminal.fontSize"; unique; [a-zA-Z0-9.]+
  section: string; // a SECTIONS id
  titleKey: string; // i18n key the page already shows
  descriptionKey?: string;
  keywords: readonly string[]; // English and Vietnamese words, lower case
  platforms?: readonly Platform[]; // only these platforms show the control; all when left out
};

const e = (id: string, titleKey: string, keywords: string[], descriptionKey?: string): SettingEntry => ({
  id,
  section: id.slice(0, id.indexOf(".")),
  titleKey,
  keywords,
  ...(descriptionKey ? { descriptionKey } : {}),
});

/** The entry, shown on `platforms` only. */
const only = (platforms: readonly Platform[], entry: SettingEntry): SettingEntry => ({ ...entry, platforms });

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
  e("general.nav.alwaysForceDeleteWorktrees", "settings.general.alwaysForceDeleteWorktrees", ["force", "delete", "remove", "worktree", "dirty", "uncommitted", "xoá", "xoa", "xóa", "ép", "ep"]),
  e("general.nav.alwaysDeleteKeptBranches", "settings.general.alwaysDeleteKeptBranches", ["branch", "delete", "keep", "kept", "unmerged", "nhánh", "nhanh", "xoá", "xoa", "xóa"]),
  e("general.language", "language.label", ["language", "locale", "english", "vietnamese", "ngôn ngữ", "ngon ngu", "tiếng việt", "tieng viet"]),
  e("general.zoom", "settings.general.zoom", ["zoom", "scale", "size", "thu phóng", "thu phong", "phóng to", "phong to"]),
  e("general.restore", "layout.setting", ["restore", "layout", "session", "reopen", "khôi phục", "khoi phuc", "bố cục", "bo cuc"], "layout.setting.hint"),
  only(["win"], e("general.minimizeToTray", "settings.general.minimizeToTray", ["tray", "minimize", "close", "background", "notification area", "khay", "thu nhỏ", "thu nho", "đóng", "dong", "nền", "nen"], "settings.general.minimizeToTrayHint")),
  only(["mac"], e("general.menuBarIcon", "settings.general.menuBarIcon", ["menu bar", "tray", "icon", "status", "thanh menu", "biểu tượng", "bieu tuong"], "settings.general.menuBarIconHint")),
  e("general.openIn", "settings.general.openIn", ["open in", "apps", "ide", "mở bằng", "mo bang", "ứng dụng", "ung dung"]),
  e("general.updates", "settings.general.updates", ["update", "version", "upgrade", "check", "restart", "cập nhật", "cap nhat", "phiên bản", "phien ban", "kiểm tra", "kiem tra"], "settings.general.updates.idle"),
  e("general.updateChannel", "settings.general.updates.channel", ["update", "channel", "release candidate", "rc", "stable", "beta", "kênh", "kenh", "ổn định", "on dinh", "thử nghiệm", "thu nghiem"], "settings.general.updates.channelHint"),
  e("general.updateDelay", "settings.general.updates.delay", ["update", "delay", "wait", "days", "later", "hold back", "trì hoãn", "tri hoan", "chờ", "cho", "ngày", "ngay"], "settings.general.updates.delayHint"),
  e("general.updateBuild", "settings.general.updates.build", ["update", "build", "release", "version", "downgrade", "older", "tag", "bản dựng", "ban dung", "phiên bản", "phien ban", "hạ cấp", "ha cap"], "settings.general.updates.buildHint"),
  e("general.diffView", "settings.general.diffView", ["diff", "inline", "split", "side by side", "view", "chế độ", "che do", "tách", "tach"]),
  e("general.diff.ignoreWhitespace", "settings.general.ignoreWhitespace", ["diff", "whitespace", "space", "khoảng trắng", "khoang trang"]),
  e("general.diff.collapseUnchanged", "settings.general.collapseUnchanged", ["diff", "collapse", "unchanged", "thu gọn", "thu gon"]),
  e("general.diff.wordWrap", "settings.general.wordWrap", ["diff", "wrap", "long lines", "xuống dòng", "xuong dong"]),
  e("general.diff.fileTree", "settings.general.fileTree", ["diff", "file tree", "tree", "cây", "cay", "tệp", "tep"], "settings.general.fileTreeHint"),
  // Appearance
  e("appearance.theme", "settings.appearance.theme", ["theme", "appearance", "dark", "light", "system", "mode", "giao diện", "giao dien", "chủ đề", "chu de", "tối", "toi", "sáng", "sang", "chế độ", "che do"], "settings.appearance.themeHint"),
  e("appearance.font", "settings.appearance.font", ["font", "typeface", "text", "family", "phông", "phong", "chữ", "chu", "kiểu chữ", "kieu chu"], "settings.appearance.fontHint"),
  e("appearance.sidebar", "settings.appearance.sidebar", ["sidebar", "tint", "tinted", "colour", "color", "thanh bên", "thanh ben", "ánh màu", "anh mau"], "settings.appearance.sidebarHint"),
  e("appearance.sidebarTint", "settings.appearance.tint", ["sidebar", "tint", "colour", "color", "opacity", "swatch", "thanh bên", "thanh ben", "ánh màu", "anh mau", "độ đậm", "do dam"], "settings.appearance.tintHint"),
  e("appearance.reduceEffects", "settings.appearance.reduceEffects", ["reduce", "effects", "motion", "animation", "blur", "transition", "giảm", "giam", "hiệu ứng", "hieu ung", "chuyển động", "chuyen dong", "làm mờ", "lam mo"], "settings.appearance.reduceEffectsHint"),
  e("appearance.titlebar", "settings.appearance.titlebar", ["title bar", "titlebar", "window", "frame", "native", "custom", "decorations", "thanh tiêu đề", "thanh tieu de", "cửa sổ", "cua so", "khung"], "settings.appearance.titlebarHint"),
  e("appearance.titlebarName", "settings.appearance.titlebarName", ["title bar", "titlebar", "app name", "name", "xdev", "thanh tiêu đề", "thanh tieu de", "tên ứng dụng", "ten ung dung"], "settings.appearance.titlebarNameHint"),
  e("appearance.appIcon", "settings.appearance.appIcon", ["app icon", "icon", "dock", "taskbar", "window", "logo", "midnight", "sunset", "forest", "mono", "biểu tượng", "bieu tuong", "thanh tác vụ", "thanh tac vu", "cửa sổ", "cua so"], "settings.appearance.appIconHint"),
  ...(["docs", "changes", "tasks", "squads", "agents", "kit", "accounts", "terminal"] as const).map((id) =>
    e(`appearance.app.${id}`, `apps.${id}`, ["activity bar", "apps", "app", "show", "hide", "sidebar", id, "thanh hoạt động", "thanh hoat dong", "ứng dụng", "ung dung", "ẩn", "an", "hiện", "hien"], "settings.appearance.appsHint"),
  ),
  e("appearance.editorTheme", "settings.appearance.editor", ["editor", "diff", "theme", "light", "dark", "colours", "colors", "trình soạn thảo", "trinh soan thao", "màu", "mau"], "settings.appearance.editorHint"),
  e("appearance.statusBar.branch", "settings.appearance.statusBar.branch", ["status bar", "footer", "branch", "thanh trạng thái", "thanh trang thai", "nhánh", "nhanh"]),
  e("appearance.statusBar.tokenUsage", "settings.appearance.statusBar.tokenUsage", ["status bar", "footer", "token", "usage", "quota", "thanh trạng thái", "thanh trang thai", "mức dùng", "muc dung"]),
  e("appearance.statusBar.agents", "settings.appearance.statusBar.agents", ["status bar", "footer", "agent", "agents", "thanh trạng thái", "thanh trang thai"]),
  e("appearance.statusBar.ports", "settings.appearance.statusBar.ports", ["status bar", "footer", "port", "ports", "localhost", "thanh trạng thái", "thanh trang thai", "cổng", "cong"]),
  e("appearance.statusBar.keepAwake", "settings.appearance.statusBar.keepAwake", ["status bar", "footer", "keep awake", "awake", "sleep", "caffeinate", "thanh trạng thái", "thanh trang thai", "thức", "thuc", "ngủ", "ngu"]),
  e("appearance.statusBar.version", "settings.appearance.statusBar.version", ["status bar", "footer", "version", "thanh trạng thái", "thanh trang thai", "phiên bản", "phien ban"]),
  e("appearance.terminalLink", "settings.appearance.terminalLink", ["terminal", "colours", "colors", "scheme", "schemes", "import", "màu", "mau", "bảng màu", "bang mau"]),
  e("appearance.usageLink", "settings.appearance.usageLink", ["usage", "credentials", "quota", "sign in", "mức dùng", "muc dung", "đăng nhập", "dang nhap"]),
  // Automations
  e("automations.showButton", "settings.automations.showButton", ["automations", "sidebar", "button", "show", "hide", "tự động hóa", "tu dong hoa", "thanh bên", "thanh ben", "ẩn", "an"], "settings.automations.showButton.hint"),
  e("automations.confirmDelete", "settings.automations.confirmDelete", ["automations", "delete", "confirm", "ask", "xóa", "xoa", "xác nhận", "xac nhan", "tự động hóa", "tu dong hoa"], "settings.automations.confirmDelete.hint"),
  e("automations.open", "settings.automations.how.title", ["automations", "how", "works", "schedule", "open", "tự động hóa", "tu dong hoa", "lịch", "lich", "mở", "mo"]),
  // Agents
  e("agents.approvals", "settings.agents.approvals", ["permission", "ask", "skip", "yolo", "phê duyệt", "phe duyet", "quyền", "quyen"]),
  e("agents.defaultAgent", "settings.agents.defaultAgent", ["default", "agent", "mặc định", "mac dinh"]),
  e("agents.defaultShell", "settings.agents.defaultShell", ["default", "shell", "mặc định", "mac dinh"]),
  e("agents.profiles", "settings.agents.profiles", ["claude", "codex", "copilot", "opencode", "gemini", "aider", "goose", "amp", "cursor", "droid", "kimi", "qwen", "devin", "install", "detect", "refresh", "profile", "enable", "cài đặt", "cai dat", "hồ sơ", "ho so"]),
  e("agents.shells", "settings.agents.shells", ["shell", "bash", "powershell", "zsh", "program", "args"]),
  e("agents.accountSwitch", "settings.agents.accountSwitch.label", ["account", "switch", "restart", "keep", "ask", "running", "agent", "tài khoản", "tai khoan", "chuyển", "chuyen", "khởi động lại", "khoi dong lai", "giữ", "giu"], "settings.agents.accountSwitch.hint"),
  e("agents.keepAwake", "settings.agents.keepAwake.label", ["awake", "sleep", "keep", "power", "caffeinate", "agent", "ngủ", "ngu", "thức", "thuc", "giữ máy", "giu may"], "settings.agents.keepAwake.hint"),
  e("agents.autoTabTitle", "settings.agents.autoTabTitle.label", ["tab", "title", "name", "prompt", "rename", "tên", "ten", "tiêu đề", "tieu de"], "settings.agents.autoTabTitle.hint"),
  e("agents.sessionSearch", "settings.agents.sessionSearch.label", ["search", "session", "conversation", "history", "index", "tìm kiếm", "tim kiem", "phiên", "phien", "hội thoại", "hoi thoai", "chỉ mục", "chi muc"], "settings.agents.sessionSearch.hint"),
  e("agents.autoSleep", "settings.agents.autoSleep.label", ["sleep", "auto", "idle", "hibernate", "agent", "tab", "minutes", "ngủ", "ngu", "tự động", "tu dong", "nhàn rỗi", "nhan roi", "phút", "phut"], "settings.agents.autoSleep.hint"),
  e("agents.workspaceTrust", "settings.agents.trust.title", ["trust", "folder", "workspace", "prompt", "tin cậy", "tin cay", "thư mục", "thu muc"], "settings.agents.trust.what"),
  e("agents.statusHooks", "settings.agents.statusHooks.label", ["hooks", "status", "trạng thái", "trang thai"], "settings.agents.statusHooks.what"),
  // Orchestration
  e("orchestration.skill", "settings.orchestration.skill.title", ["orchestration", "skill", "install", "coordinate", "agents", "handoff", "worker", "điều phối", "dieu phoi", "cài đặt", "cai dat", "bàn giao", "ban giao"], "settings.orchestration.skill.text"),
  e("orchestration.depth", "settings.orchestration.depth.label", ["nested", "depth", "worker", "child", "spawn", "orchestration", "lồng nhau", "long nhau", "độ sâu", "do sau", "điều phối", "dieu phoi"], "settings.orchestration.depth.hint"),
  e("orchestration.autoClose", "settings.orchestration.autoClose.label", ["auto-close", "close", "release", "finished", "worker", "tab", "terminal", "orchestration", "đóng", "dong", "tự đóng", "tu dong", "điều phối", "dieu phoi"], "settings.orchestration.autoClose.hint"),
  e("orchestration.failover", "settings.orchestration.failover.enabled", ["failover", "fail over", "backup", "fallback", "failed", "worker", "quota", "rate limit", "orchestration", "dự phòng", "du phong", "thay thế", "thay the", "hạn mức", "han muc"], "settings.orchestration.failover.hint"),
  e("orchestration.failoverAccount", "settings.orchestration.failover.account", ["failover", "account", "backup", "quota", "provider", "tài khoản", "tai khoan", "dự phòng", "du phong"], "settings.orchestration.failover.accountHint"),
  e("orchestration.failoverAgents", "settings.orchestration.failover.agents", ["failover", "backup", "agent", "fallback", "order", "reorder", "dự phòng", "du phong", "tác tử", "tac tu", "thứ tự", "thu tu"]),
  e("orchestration.failoverMax", "settings.orchestration.failover.max", ["failover", "max", "limit", "count", "retries", "dự phòng", "du phong", "tối đa", "toi da"], "settings.orchestration.failover.maxHint"),
  e("orchestration.autopilot", "settings.orchestration.failover.autopilot", ["autopilot", "restart", "stuck", "hang", "frozen", "minutes", "worker", "khởi động lại", "khoi dong lai", "treo", "phút", "phut"], "settings.orchestration.failover.autopilotHint"),
  e("orchestration.howTo", "settings.orchestration.howTo.title", ["how to", "prompt", "handoff", "child agents", "parallel", "sequence", "worktree", "orchestration", "cách dùng", "cach dung", "hướng dẫn", "huong dan", "điều phối", "dieu phoi"]),
  // Stats & Usage
  e("usage.display", "settings.usage.display", ["usage", "percent", "percentage", "used", "remaining", "left", "meter", "footer", "đã dùng", "da dung", "còn lại", "con lai", "phần trăm", "phan tram"], "settings.usage.displayHint"),
  e("usage.footer.claude", "settings.usage.footer.claude", ["footer", "meter", "claude", "usage", "quota", "thanh", "mức dùng", "muc dung", "chân trang", "chan trang"]),
  e("usage.footer.codex", "settings.usage.footer.codex", ["footer", "meter", "codex", "usage", "quota", "thanh", "mức dùng", "muc dung", "chân trang", "chan trang"]),
  e("usage.scan.claude", "settings.usage.scan.claude", ["stats", "logs", "scan", "read", "claude", "session", "thống kê", "thong ke", "đọc log", "doc log", "nhật ký", "nhat ky"], "settings.usage.scanHint"),
  e("usage.scan.codex", "settings.usage.scan.codex", ["stats", "logs", "scan", "read", "codex", "session", "thống kê", "thong ke", "đọc log", "doc log", "nhật ký", "nhat ky"], "settings.usage.scanHint"),
  e("usage.credentials", "settings.usage.credentials.group", ["credentials", "sign in", "login", "account", "token", "expired", "claude", "codex", "đăng nhập", "dang nhap", "tài khoản", "tai khoan", "hết hạn", "het han"]),
  e("usage.apiKeys", "settings.usage.apiKeys.group", ["api", "key", "keys", "anthropic", "openai", "gemini", "keychain", "token", "khóa", "khoa", "khóa api", "khoa api"], "settings.usage.apiKeys.hint"),
  e("usage.cacheTimer", "settings.usage.cacheTimer", ["cache", "timer", "countdown", "prompt cache", "claude", "tab", "đồng hồ", "dong ho", "đếm ngược", "dem nguoc", "bộ nhớ đệm", "bo nho dem"], "settings.usage.cacheTimerHint"),
  e("usage.cacheTtl", "settings.usage.cacheTtl", ["cache", "lifetime", "ttl", "5 minutes", "1 hour", "thời hạn", "thoi han", "5 phút", "5 phut", "1 giờ", "1 gio"]),
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
  e("terminal.theme", "settings.terminal.theme.label", ["theme", "colour", "color", "scheme", "dark", "light", "màu", "mau", "giao diện", "giao dien", "bảng màu", "bang mau"], "settings.terminal.theme.hint"),
  e("terminal.themeFollowApp", "settings.terminal.theme.followApp", ["theme", "light", "dark", "mode", "scheme", "sáng", "sang", "tối", "toi", "bảng màu", "bang mau"], "settings.terminal.theme.followAppHint"),
  e("terminal.themeLight", "settings.terminal.theme.light", ["theme", "light", "scheme", "sáng", "sang", "bảng màu", "bang mau"]),
  e("terminal.fontWeightBold", "settings.terminal.text.boldWeight", ["bold", "weight", "font", "đậm", "dam", "độ đậm", "do dam"]),
  e("terminal.scrollOnInput", "settings.terminal.text.scrollOnInput", ["scroll", "typing", "bottom", "cuộn", "cuon", "gõ", "go"], "settings.terminal.text.scrollOnInputHint"),
  e("terminal.paddingPx", "settings.terminal.space.padding", ["padding", "margin", "space", "gap", "lề", "le", "khoảng cách", "khoang cach"]),
  e("terminal.backgroundOpacity", "settings.terminal.space.opacity", ["opacity", "transparent", "transparency", "background", "trong suốt", "trong suot", "độ mờ", "do mo"], "settings.terminal.space.opacityHint"),
  e("terminal.dimInactivePanes", "settings.terminal.panes.dim", ["dim", "inactive", "pane", "focus", "mờ", "mo", "ô", "tối", "toi"], "settings.terminal.panes.dimHint"),
  e("terminal.paneDividerPx", "settings.terminal.panes.divider", ["divider", "border", "line", "split", "pane", "thickness", "đường", "duong", "viền", "vien", "độ dày", "do day"]),
  e("terminal.themeImport", "settings.terminal.import.button", ["theme", "import", "scheme", "colour", "color", "file", "json", "nhập", "nhap", "giao diện", "giao dien", "bảng màu", "bang mau"], "settings.terminal.import.hint"),
  e("terminal.gpu", "settings.terminal.render.gpu", ["gpu", "webgl", "renderer", "acceleration", "dom", "tăng tốc", "tang toc", "hiển thị", "hien thi"], "settings.terminal.render.gpuHint"),
  e("terminal.minimumContrast", "settings.terminal.render.contrast", ["contrast", "readable", "accessibility", "tương phản", "tuong phan", "màu", "mau"], "settings.terminal.render.contrastHint"),
  e("terminal.scrollSensitivity", "settings.terminal.interaction.scroll", ["scroll", "speed", "wheel", "cuộn", "cuon", "tốc độ", "toc do"]),
  e("terminal.fastScrollSensitivity", "settings.terminal.interaction.fastScroll", ["scroll", "fast", "alt", "speed", "cuộn", "cuon", "nhanh"]),
  e("terminal.focusFollowsMouse", "settings.terminal.interaction.focusFollowsMouse", ["focus", "mouse", "hover", "pointer", "tiêu điểm", "tieu diem", "chuột", "chuot"], "settings.terminal.interaction.focusFollowsMouseHint"),
  e("terminal.linkClick", "settings.terminal.links.click", ["link", "url", "path", "click", "open", "actions", "liên kết", "lien ket", "nhấp", "nhap"], "settings.terminal.links.hint"),
  e("terminal.urlMiddleClick", "settings.terminal.links.middleClick", ["link", "url", "middle", "click", "open", "liên kết", "lien ket", "chuột giữa", "chuot giua", "nhấp", "nhap"]),
  e("terminal.bell", "settings.terminal.bell.label", ["bell", "beep", "flash", "sound", "visual", "chuông", "chuong", "âm thanh", "am thanh"], "settings.terminal.bell.hint"),
  e("terminal.wordSeparators", "settings.terminal.words.label", ["word", "separator", "double click", "select", "từ", "tu", "phân tách", "phan tach", "bấm đúp", "bam dup"], "settings.terminal.words.hint"),
  e("terminal.scrollback", "settings.terminal.scrollback", ["buffer", "history", "lines", "lịch sử", "lich su"], "settings.terminal.scrollbackHint"),
  only(["mac"], e("terminal.optionAsAlt", "settings.terminal.keyboard.optionAsAlt", ["option", "alt", "meta", "esc", "keyboard", "layout", "mac", "bàn phím", "ban phim", "phím", "phim"], "settings.terminal.keyboard.optionAsAltHint")),
  e("terminal.copyOnSelect", "settings.terminal.copyOnSelect", ["clipboard", "copy", "select", "sao chép", "sao chep"]),
  e("terminal.rightClickPaste", "settings.terminal.rightClickPaste", ["clipboard", "paste", "mouse", "dán", "dan"]),
  e("terminal.osc52Clipboard", "settings.terminal.osc52Clipboard", ["clipboard", "osc52", "osc 52"], "settings.terminal.osc52ClipboardHint"),
  e("terminal.service", "settings.terminal.service.label", ["service", "daemon", "background", "keep running", "quit", "dịch vụ", "dich vu", "chạy nền", "chay nen"], "settings.terminal.service.hint"),
  e("terminal.onQuit", "settings.terminal.service.onQuit", ["quit", "close", "exit", "end", "ask", "thoát", "thoat", "đóng", "dong"]),
  e("terminal.ringMb", "settings.terminal.service.ringMb", ["ring", "buffer", "output", "memory", "bộ nhớ", "bo nho"], "settings.terminal.service.ringMbHint"),
  e("terminal.saveScrollback", "settings.terminal.saveScrollback", ["save", "output", "scrollback", "history", "restore", "lưu", "luu", "nội dung", "noi dung"], "settings.terminal.saveScrollbackHint"),
  e("terminal.running", "settings.terminal.service.running", ["running", "service", "end", "restart", "đang chạy", "dang chay", "khởi động lại", "khoi dong lai"]),
  e("terminal.reset", "settings.terminal.reset", ["defaults", "reset", "đặt lại", "dat lai"]),
  // Editor
  e("editor.autosave", "files.settings.autosave", ["save", "tự động lưu", "tu dong luu"], "files.settings.autosaveHint"),
  e("editor.wordWrap", "files.settings.wordWrap", ["wrap", "xuống dòng", "xuong dong"]),
  e("editor.autosaveMs", "files.settings.autosaveMs", ["save", "delay", "milliseconds", "độ trễ", "do tre"]),
  e("editor.fontSize", "files.settings.fontSize", ["font", "cỡ chữ", "co chu", "phông", "phong"]),
  e("editor.fontFamily", "files.settings.fontFamily.catalog", ["font", "family", "typeface", "monospace", "terminal", "phông", "phong", "phông chữ", "phong chu"], "files.settings.fontFamily.hint"),
  e("editor.tabSize", "files.settings.tabSize", ["tab", "indent", "thụt lề", "thut le"], "files.settings.tabSizeHint"),
  // Repositories (the same fields on every repo card)
  e("repos.color", "settings.repos.identity.color", ["colour", "color", "badge", "tag", "hex", "màu", "mau", "nhãn", "nhan"], "settings.repos.identity.color.hint"),
  e("repos.icon", "settings.repos.identity.icon", ["icon", "emoji", "letter", "badge", "biểu tượng", "bieu tuong"]),
  e("repos.ghAccount", "settings.repos.gh", ["github", "gh", "login", "account", "pr", "issue", "tài khoản", "tai khoan", "đăng nhập", "dang nhap"], "settings.repos.gh.hint"),
  e("repos.shortName", "settings.repos.shortName", ["name", "repo", "tên", "ten"], "settings.repos.shortNameNote"),
  e("repos.baseRef", "settings.repos.baseRef", ["base", "branch", "main", "nhánh", "nhanh"], "settings.repos.baseRefHint"),
  e("repos.worktreeRoot", "settings.repos.worktreeRoot", ["folder", "directory", "path", "thư mục", "thu muc"], "settings.repos.worktreeRootHint"),
  e("repos.sparsePresets", "settings.repos.presets", ["sparse", "preset", "folders", "checkout", "mẫu", "mau", "thư mục", "thu muc"], "settings.repos.presets.hint"),
  e("repos.env", "settings.repos.env", ["environment", "env", "variable", "variables", "secret", "key", "value", "terminal", "biến môi trường", "bien moi truong", "bí mật", "bi mat"], "settings.repos.env.hint"),
  e("repos.scriptPolicy", "settings.repos.scripts.policy", ["setup", "script", "run", "kịch bản", "kich ban"]),
  e("repos.scriptSource", "settings.repos.scripts.source", ["setup", "script", "shared", "local", "kịch bản", "kich ban"]),
  e("repos.localScripts", "settings.repos.scripts", ["setup", "archive", "script", "kịch bản", "kich ban"], "settings.repos.scripts.localHint"),
  e("repos.issueCommand", "settings.repos.issue", ["issue", "prompt", "template", "agent", "github", "lệnh", "lenh", "mẫu", "mau"], "settings.repos.issue.hint"),
  e("repos.repoFile", "settings.repos.file", ["xdev.toml", "shared", "tabs", "unknown", "node_modules", "tab mặc định", "tab mac dinh"], "settings.repos.file.hint"),
  e("repos.mcpConfigs", "settings.repos.mcp.title", ["mcp", "server", "config", "json", "máy chủ", "may chu", "cấu hình", "cau hinh"], "settings.repos.mcp.hint"),
  e("repos.sharedScripts", "settings.repos.scripts.shared", ["trust", "script", "tin cậy", "tin cay"], "settings.repos.scripts.trustNote"),
  // Account
  e("account.xdevId", "account.xdevId", ["account", "sign in", "sign out", "login", "xdev id", "tài khoản", "tai khoan", "đăng nhập", "dang nhap", "đăng xuất", "dang xuat"], "account.about"),
  e("account.server", "account.server.title", ["server", "on-prem", "self-hosted", "url", "address", "xdev id", "máy chủ", "may chu", "địa chỉ", "dia chi"], "account.server.hint"),
  // Open in
  e("openIn.apps", "openIn.title", ["editor", "vscode", "app", "command", "args", "mở bằng", "mo bang"], "openIn.intro"),
  // Git
  e("git.prefix", "settings.git.prefix", ["branch", "name", "username", "nhánh", "nhanh", "tiền tố", "tien to"]),
  e("git.compare", "settings.git.compare", ["diff", "upstream", "base", "so sánh", "so sanh"], "settings.git.compareHint"),
  e("git.pullPolicy", "settings.git.pullPolicy", ["pull", "merge", "rebase", "fast-forward", "ff"], "settings.git.pullPolicyHint"),
  e("git.groupOrder", "settings.git.groupOrder", ["staged", "changes", "order", "thứ tự", "thu tu"], "settings.git.groupOrderHint"),
  e("git.refresh", "settings.git.refresh", ["fetch", "pull", "base", "create", "làm mới", "lam moi"], "settings.git.refreshHint"),
  e("git.baseTip", "settings.git.baseTip", ["behind", "base", "upstream", "tip", "toast", "chậm", "cham", "nhánh gốc", "nhanh goc"], "settings.git.baseTipHint"),
  e("git.worktreeDir", "settings.git.worktreeDir", ["worktree", "folder", "directory", "path", "location", "thư mục", "thu muc", "đường dẫn", "duong dan"], "settings.git.worktreeDirHint"),
  e("git.issuesView", "settings.git.issuesView", ["issues", "pull request", "review", "start", "default", "mặc định", "mac dinh"]),
  e("git.issuesTab", "settings.git.issuesTab", ["issues", "tab", "hide", "ẩn", "an"], "settings.git.issuesTabHint"),
  e("git.autoRename", "settings.git.autoRename.title", ["rename", "branch", "name", "prompt", "đổi tên", "doi ten", "nhánh", "nhanh"], "settings.git.autoRename.hint"),
  e("git.ai", "settings.git.ai.show", ["ai", "commit", "message", "source control"], "settings.git.ai.showHint"),
  e("git.pr", "settings.git.pr.title", ["pull request", "draft", "pr"]),
  e("git.botAuthors", "settings.git.botAuthors.title", ["bot", "author", "comments", "filter", "pr", "tác giả", "tac gia", "bình luận", "binh luan"], "settings.git.botAuthors.hint"),
  // Vaults
  e("vaults.repo", "settings.vaults.repo", ["docs", "notes", "repo", "tài liệu", "tai lieu"]),
  e("vaults.shared", "settings.vaults.shared", ["docs", "notes", "add", "forget", "folder", "tài liệu", "tai lieu", "chia sẻ", "chia se"]),
  // Shortcuts and quick commands: the page keeps its own list search, so one entry each.
  e("keys.page", "keys.title", ["shortcut", "keybinding", "hotkey", "chord", "phím tắt", "phim tat"]),
  e("qcmd.page", "qcmd.title", ["quick", "command", "script", "alias", "lệnh nhanh", "lenh nhanh"]),
  // Command line
  e("cli.status", "settings.cli.command", ["cli", "xdev", "command", "path", "terminal", "install", "dòng lệnh", "dong lenh", "lệnh", "lenh"], "settings.cli.lead"),
  e("cli.skill", "settings.orchestration.skill.title", ["cli", "skill", "agent", "xdev", "kỹ năng", "ky nang"]),
  // SSH: the page keeps its own host filter, so one entry.
  e("ssh.hosts", "ssh.title", ["ssh", "host", "hosts", "server", "remote", "terminal", "config", "máy chủ", "may chu", "từ xa", "tu xa"], "ssh.intro"),
  // Diagnostics
  e("diagnostics.export", "diagnostics.export.title", ["diagnostics", "export", "bundle", "chẩn đoán", "chan doan", "xuất", "xuat"]),
  e("diagnostics.logs", "diagnostics.logs.title", ["diagnostics", "log", "logs", "nhật ký", "nhat ky"]),
  e("diagnostics.crash", "diagnostics.crash.title", ["diagnostics", "crash", "report", "sự cố", "su co", "chẩn đoán", "chan doan"]),
  // Experimental
  e("experimental.autoSleep", "settings.agents.autoSleep.label", ["experimental", "beta", "lab", "sleep", "auto", "thử nghiệm", "thu nghiem"], "settings.agents.autoSleep.hint"),
  // Advanced
  e("advanced.proxy", "settings.advanced.proxy", ["proxy", "http", "https", "socks5", "network", "terminal", "update", "máy chủ proxy", "may chu proxy", "mạng", "mang"], "settings.advanced.proxy.hint"),
  e("advanced.noProxy", "settings.advanced.noProxy", ["proxy", "bypass", "no_proxy", "exclude", "hosts", "bỏ qua", "bo qua", "loại trừ", "loai tru"], "settings.advanced.noProxy.hint"),
  e("advanced.nodeMirror", "settings.advanced.nodeMirror", ["node", "npm", "registry", "mirror", "package", "gương", "guong", "kho gói", "kho goi"], "settings.advanced.nodeMirror.hint"),
  e("advanced.export", "settings.config.export", ["export", "import", "backup", "restore", "settings", "save", "load", "json", "xuất", "xuat", "nhập", "nhap", "sao lưu", "sao luu"], "settings.config.export.hint"),
  e("advanced.machineName", "settings.advanced.machineName", ["machine", "name", "host", "hostname", "computer", "device", "tên máy", "ten may", "máy tính", "may tinh"], "settings.advanced.machineName.hint"),
  // Account: agent account routing
  e("account.routing.policy", "settings.account.routing.policy", ["account", "routing", "policy", "quota", "round robin", "priority", "most quota", "new tab", "tài khoản", "tai khoan", "định tuyến", "dinh tuyen", "hạn mức", "han muc", "luân phiên", "luan phien", "ưu tiên", "uu tien"], "settings.account.routing.lead"),
  e("account.routing.pool", "settings.account.routing.pool", ["account", "pool", "routing", "subset", "tài khoản", "tai khoan", "nhóm", "nhom"]),
  e("account.routing.priority", "settings.account.routing.priority", ["priority", "order", "account", "reorder", "ưu tiên", "uu tien", "thứ tự", "thu tu"]),
  e("account.routing.thresholds", "settings.account.routing.firstAlert", ["quota", "alert", "threshold", "limit", "percent", "5 hours", "weekly", "hạn mức", "han muc", "cảnh báo", "canh bao", "ngưỡng", "nguong"], "settings.account.routing.thresholdsHint"),
  e("account.routing.autoSwitch", "settings.account.routing.autoSwitchTitle", ["auto", "switch", "account", "quota", "limit", "new agent", "tự động", "tu dong", "chuyển", "chuyen", "tài khoản", "tai khoan"], "settings.account.routing.terms"),
  // MCP
  e("mcp.health", "settings.mcp.health.title", ["mcp", "server", "health", "version", "check", "running", "máy chủ", "may chu", "kiểm tra", "kiem tra", "phiên bản", "phien ban"]),
  e("mcp.tools", "settings.mcp.tools.title", ["mcp", "tools", "tool", "switch", "enable", "disable", "send_to_tab", "read_tab_output", "create_worktree", "list_tabs", "công cụ", "cong cu", "bật", "bat", "tắt", "tat"], "settings.mcp.tools.hint"),
  e("mcp.activity", "settings.mcp.activity.title", ["mcp", "activity", "log", "calls", "history", "hoạt động", "hoat dong", "nhật ký", "nhat ky", "lịch sử", "lich su"], "settings.mcp.activity.hint"),
  e("mcp.addToRepo", "settings.mcp.add.title", ["mcp", ".mcp.json", "repo", "add", "config", "project", "thêm", "them", "cấu hình", "cau hinh", "dự án", "du an"]),
  e("mcp.agents", "settings.mcp.agents.title", ["mcp", "claude", "codex", "gemini", "command", "user scope", "copy", "lệnh", "lenh", "sao chép", "sao chep"]),
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

/** The entries this platform shows; the search and the palette use these. */
export function entriesFor(platform: Platform = PLATFORM): SettingEntry[] {
  return SETTING_ENTRIES.filter((x) => !x.platforms || x.platforms.includes(platform));
}
