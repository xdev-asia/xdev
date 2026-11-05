import { expect, it } from "vitest";
import { profileName } from "@/agents/profileStore";
import { sshProfiles } from "./sshHosts";

it("a host opens as a shell profile named by its alias", () => {
  expect(sshProfiles(["web", "db:1"])).toEqual(["shell:ssh:web", "shell:ssh:db:1"]);
  const t = (k: string) => k;
  expect(profileName(null, "shell:ssh:web", t)).toBe("web");
  expect(profileName(null, "shell:ssh:db:1", t)).toBe("db:1");
});
