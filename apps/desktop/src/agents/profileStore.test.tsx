import { describe, expect, it } from "vitest";
import { createMockApi } from "@/mockApi";
import { profileLetter, profileName } from "./profileStore";

const t = (key: string) => `T:${key}`;

describe("profile helpers", () => {
  it("profile_name_falls_back_without_view", () => {
    expect(profileName(null, "claude", t)).toBe("T:terminal.profile.claude");
    expect(profileName(null, "shell", t)).toBe("T:terminal.profile.shell");
    expect(profileLetter(null, "codex")).toBe("X");
    expect(profileLetter(null, "shell:cmd")).toBe("S");
  });

  it("letter_for_custom_profile", async () => {
    const api = createMockApi({});
    const base = await api.profiles();
    const view = await api.profilePut({
      id: "aider", name: "aider", cli: null, program: "aider", args: [], env: [], model: null,
      effort: null, permissions: null, account: null, startup: [], enabled: true,
    });
    expect(base.profiles.some((p) => p.profile.id === "aider")).toBe(false);
    expect(profileLetter(view, "aider")).toBe("A");
    expect(profileName(view, "aider", t)).toBe("aider");
    expect(profileName(view, "gone", t)).toBe("T:terminal.profile.gone");
    expect(profileName(view, "shell:wsl:Ubuntu", t)).toBe("WSL Ubuntu");
  });
});
