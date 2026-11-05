import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SshAuthPrompt } from "@/api";
import { translate } from "@/i18n";
import { createMockSsh } from "@/mockSsh";
import { SshAuthDialog, SshAuthPrompts, dropPrompt, queuePrompt } from "./SshAuthDialog";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const ask = (requestId: string, kind: SshAuthPrompt["kind"] = "password", prompt = "deploy@web.example.com password: "): SshAuthPrompt => ({ requestId, hostId: "1", alias: "web", kind, prompt });

it("shows ssh's prompt, a masked answer, and Cancel / Continue", () => {
  const html = renderToStaticMarkup(<SshAuthDialog prompt={ask("a")} onReply={() => {}} />);
  expect(html).toContain(en("ssh.auth.title", { alias: "web" }));
  expect(html).toContain("deploy@web.example.com password:");
  expect(html).toContain(en("ssh.auth.password"));
  expect(html).toContain('type="password"');
  expect(html).toContain(en("ssh.auth.hint"));
  expect(html).toContain(en("ssh.auth.cancel"));
  expect(html).toContain(en("ssh.auth.continue"));
});

it("names a passphrase and keeps it masked; a yes/no question is plain text", () => {
  const phrase = renderToStaticMarkup(<SshAuthDialog prompt={ask("a", "passphrase", "Enter passphrase for key 'C:/k':")} onReply={() => {}} />);
  expect(phrase).toContain(en("ssh.auth.passphrase"));
  expect(phrase).toContain('type="password"');
  const confirm = renderToStaticMarkup(<SshAuthDialog prompt={ask("b", "confirm", "Are you sure you want to continue connecting (yes/no)?")} onReply={() => {}} />);
  expect(confirm).toContain('type="text"');
  expect(confirm).toContain(en("ssh.auth.confirmHint"));
});

it("queues prompts once each, first come first shown, and drops a closed one", () => {
  let q = queuePrompt([], ask("a"));
  q = queuePrompt(q, ask("b"));
  q = queuePrompt(q, ask("a"));
  expect(q.map((p) => p.requestId)).toEqual(["a", "b"]);
  expect(dropPrompt(q, "a").map((p) => p.requestId)).toEqual(["b"]);
  expect(dropPrompt(q, "zzz")).toEqual(q);
});

it("shows nothing while no prompt waits", () => {
  expect(renderToStaticMarkup(<SshAuthPrompts api={createMockSsh()} />)).toBe("");
});
