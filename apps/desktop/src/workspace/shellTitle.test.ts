import { describe, expect, it } from "vitest";
import { shellTitle } from "./shellTitle";

describe("shellTitle", () => {
  it("names a shell whose title is its own path", () => {
    expect(shellTitle("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toBe("PowerShell");
    expect(shellTitle("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe("PowerShell");
    expect(shellTitle("C:\\Windows\\System32\\cmd.exe")).toBe("Command Prompt");
    expect(shellTitle("C:\\Program Files\\Git\\bin\\bash.exe")).toBe("Git Bash");
    expect(shellTitle("/bin/zsh")).toBe("zsh");
    expect(shellTitle("powershell.exe")).toBe("PowerShell");
  });
  it("takes the WSL distro from the profile name", () => {
    expect(shellTitle("C:\\Windows\\System32\\wsl.exe", "WSL: Ubuntu")).toBe("WSL: Ubuntu");
    expect(shellTitle("C:\\Windows\\System32\\wsl.exe")).toBe("WSL");
  });
  it("keeps a title a program set", () => {
    expect(shellTitle("vim main.rs")).toBe("vim main.rs");
    expect(shellTitle("user@host: ~/code")).toBe("user@host: ~/code");
    expect(shellTitle("claude")).toBe("claude");
    expect(shellTitle("bash")).toBe("bash");
    expect(shellTitle("~/bin/zsh-setup.sh")).toBe("~/bin/zsh-setup.sh");
    expect(shellTitle("")).toBe("");
  });
});
