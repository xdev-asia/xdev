import { describe, expect, it } from "vitest";
import type { Profile, ShellView } from "@/api";
import { draftOf, freeId, profileOf, wslDistros } from "./agentForm";

describe("freeId", () => {
  it("never gives a reserved id", () => {
    expect(freeId("Auto", [], "custom")).toBe("auto-2");
    expect(freeId("Blank", [], "custom")).toBe("blank-2");
    expect(freeId("Shell", [], "custom")).toBe("shell-2");
    expect(freeId("Mine", ["mine"], "custom")).toBe("mine-2");
    expect(freeId("", [], "custom")).toBe("custom");
  });
});

const claude: Profile = {
  id: "claude",
  name: "Claude Code",
  cli: "claude",
  program: null,
  args: [],
  env: [],
  model: null,
  effort: null,
  permissions: null,
  account: null,
  startup: [],
  enabled: true,
};

describe("openAs", () => {
  it("drafts blank for no field and the stored value otherwise", () => {
    expect(draftOf(claude).openAs).toBe("");
    expect(draftOf(null).openAs).toBe("");
    expect(draftOf({ ...claude, openAs: "chat" }).openAs).toBe("chat");
  });

  it("leaves the key out when blank and saves terminal or chat", () => {
    const blank = profileOf({ ...draftOf(claude), openAs: "" }, claude, "claude")!;
    expect("openAs" in blank).toBe(false);
    expect(profileOf({ ...draftOf(claude), openAs: "chat" }, claude, "claude")!.openAs).toBe("chat");
    expect(profileOf({ ...draftOf(claude), openAs: "terminal" }, claude, "claude")!.openAs).toBe("terminal");
  });
});

describe("wsl", () => {
  it("drafts the distro, blank for Windows", () => {
    expect(draftOf({ ...claude, wsl: "Ubuntu" }).wsl).toBe("Ubuntu");
    expect(draftOf(claude).wsl).toBe("");
    expect(draftOf(null).wsl).toBe("");
  });

  it("saves a distro and leaves the key out for Windows", () => {
    const windows = profileOf({ ...draftOf(claude), wsl: "" }, claude, "claude")!;
    expect("wsl" in windows).toBe(false);
    expect(windows).toEqual(claude);
    expect(profileOf({ ...draftOf(claude), wsl: "Ubuntu" }, claude, "claude")).toEqual({ ...claude, wsl: "Ubuntu" });
  });

  it("reads the distros from the WSL shell ids", () => {
    const shells: ShellView[] = [
      { id: "shell:powershell", name: "PowerShell", kind: "powershell", custom: false },
      { id: "shell:wsl:Ubuntu", name: "WSL Ubuntu", kind: "wsl", custom: false },
      { id: "shell:wsl:Debian-12", name: "Debian-12", kind: "wsl", custom: false },
    ];
    expect(wslDistros(shells)).toEqual(["Ubuntu", "Debian-12"]);
    expect(wslDistros([])).toEqual([]);
  });
});
