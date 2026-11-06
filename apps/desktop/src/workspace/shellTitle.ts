// A shell prints its own path as the terminal title (Windows PowerShell does). That is not a name for a tab.

const SHELLS: Readonly<Record<string, string>> = {
  powershell: "PowerShell",
  pwsh: "PowerShell",
  cmd: "Command Prompt",
  bash: "Bash",
  zsh: "zsh",
  fish: "fish",
  sh: "sh",
  nu: "Nushell",
  wsl: "WSL",
  ubuntu: "WSL: Ubuntu",
};

/** The program of a title that is only a path or file name of a shell (a Windows path, "/bin/zsh"); null for any other title. */
function executableOf(title: string): string | null {
  const text = title.trim().replace(/^["']|["']$/g, "");
  if (text === "") return null;
  const hasDir = /[\\/]/.test(text);
  const name = text.split(/[\\/]/).pop() ?? "";
  const stem = name.replace(/\.exe$/i, "").toLowerCase();
  if (!(stem in SHELLS)) return null;
  // A bare "bash" or "sh" is a title a program may set; a path or an .exe is the shell naming itself.
  return hasDir || /\.exe$/i.test(name) ? stem : null;
}

/**
 * The title to show: a shell's own path becomes its name ("PowerShell", "Command Prompt", "Git Bash", "WSL: Ubuntu").
 * `profileLabel` is the profile's name (it carries the distro of a WSL profile). A title a program set stays as it is.
 */
export function shellTitle(title: string, profileLabel?: string): string {
  const stem = executableOf(title);
  if (stem === null) return title;
  const label = profileLabel?.trim() ?? "";
  if (stem === "wsl" && /^wsl/i.test(label)) return label;
  if (stem === "bash" && (/git/i.test(title) || /^git/i.test(label))) return "Git Bash";
  return SHELLS[stem]!;
}
