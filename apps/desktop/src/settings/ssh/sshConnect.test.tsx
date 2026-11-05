import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi, type SshAuthPrompt, type SshConnState, type SshHost } from "@/api";
import { translate } from "@/i18n";
import { createMockSsh, mockSshOutcome } from "@/mockSsh";
import { SshHostList, type TestState } from "./SshHostList";
import { connLine, isLive, testLine } from "./sshModel";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const host = (id: string, alias: string): SshHost => ({ id, alias, hostName: `${alias}.example.com`, source: "manual", forwardAgent: false, localForwards: [], extraOptions: [] });
const web = host("1", "web");
const db = host("2", "db");

/** Waits for `check` to hold, up to 3 s. */
async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const row = (tests: Map<string, TestState>, conns: Map<string, SshConnState> = new Map()) =>
  renderToStaticMarkup(
    <SshHostList hosts={[web, db]} total={2} selected={new Set()} tests={tests} conns={conns} onToggle={() => {}} onEdit={() => {}} onRemove={() => {}} onTest={() => {}} onConnect={() => {}} onDisconnect={() => {}} />,
  );

it("words each test outcome with a tone", () => {
  expect(testLine({ kind: "ok" })).toEqual({ key: "ssh.test.ok", tone: "ok" });
  expect(testLine({ kind: "authRequired" }).tone).toBe("warn");
  expect(testLine({ kind: "hostKeyUnknown" }).key).toBe("ssh.test.hostKeyUnknown");
  expect(testLine({ kind: "unreachable" }).tone).toBe("danger");
  expect(testLine({ kind: "failed", message: "boom" })).toEqual({ key: "ssh.test.failed", vars: { message: "boom" }, tone: "danger" });
  for (const kind of ["ok", "authRequired", "hostKeyUnknown", "unreachable"] as const) expect(en(testLine({ kind }).key)).not.toBe(testLine({ kind }).key);
});

it("words each connection state and names a failure's reason", () => {
  expect(connLine({ kind: "connected" })).toEqual({ key: "ssh.conn.connected", tone: "ok" });
  expect(connLine({ kind: "connecting" }).tone).toBe("warn");
  expect(connLine({ kind: "disconnected" }).tone).toBe("neutral");
  expect(connLine({ kind: "failed", reason: "auth_required" }).key).toBe("ssh.conn.reason.authRequired");
  expect(connLine({ kind: "failed", reason: "unreachable" }).key).toBe("ssh.conn.reason.unreachable");
  expect(connLine({ kind: "failed", reason: "spawn: program not found" })).toEqual({ key: "ssh.conn.reason.other", vars: { message: "spawn: program not found" }, tone: "danger" });
  expect(isLive({ kind: "connecting" })).toBe(true);
  expect(isLive({ kind: "connected" })).toBe(true);
  expect(isLive({ kind: "failed", reason: "x" })).toBe(false);
  expect(isLive(undefined)).toBe(false);
});

it("each row has a Test button and shows the result inline", () => {
  const idle = row(new Map());
  expect(idle.match(new RegExp(`>${en("ssh.test")}<`, "g"))?.length).toBe(2);
  expect(idle).not.toContain('data-testid="ssh-test-result"');

  const running = row(new Map([["1", "running"]]));
  expect(running).toContain(en("ssh.test.running", { alias: "web" }));
  expect(running).toContain("disabled");

  const done = row(new Map<string, TestState>([["1", { kind: "ok" }], ["2", { kind: "unreachable" }]]));
  expect(done).toContain(en("ssh.test.ok"));
  expect(done).toContain(en("ssh.test.unreachable"));
  expect(done.match(/data-testid="ssh-test-result"/g)?.length).toBe(2);
  expect(done).toContain('data-tone="danger"');
});

it("a row offers Connect, or Disconnect while the connection is live, and shows its state", () => {
  const html = row(new Map(), new Map<string, SshConnState>([["1", { kind: "connected" }], ["2", { kind: "failed", reason: "unreachable" }]]));
  expect(html.match(new RegExp(`>${en("ssh.disconnect")}<`, "g"))?.length).toBe(1);
  expect(html.match(new RegExp(`>${en("ssh.connect")}<`, "g"))?.length).toBe(1);
  expect(html).toContain(en("ssh.conn.connected"));
  expect(html).toContain(en("ssh.conn.reason.unreachable"));
});

it("the mock picks a test outcome from the alias", async () => {
  expect(mockSshOutcome("web")).toEqual({ kind: "ok" });
  expect(mockSshOutcome("denied-box").kind).toBe("authRequired");
  expect(mockSshOutcome("newkey").kind).toBe("hostKeyUnknown");
  expect(mockSshOutcome("down").kind).toBe("unreachable");
  expect(mockSshOutcome("broken").kind).toBe("failed");
  const ssh = createMockSsh([web, host("3", "down")]);
  expect(await ssh.sshHostTest("1")).toEqual({ kind: "ok" });
  expect(await ssh.sshHostTest("3")).toEqual({ kind: "unreachable" });
  await expect(ssh.sshHostTest("nope")).rejects.toMatchObject({ code: "not_found" });
});

it("a mock connect goes connecting, then connected after a delay, and disconnects", async () => {
  const ssh = createMockSsh([web]);
  const seen: string[] = [];
  const off = await ssh.onSshState((v) => seen.push(`${v.alias}:${v.state.kind}`));
  expect((await ssh.sshConnect("1")).state).toEqual({ kind: "connecting" });
  await until(() => seen.includes("web:connected"));
  expect(seen).toEqual(["web:connecting", "web:connected"]);
  expect((await ssh.sshConnect("1")).state).toEqual({ kind: "connected" });
  expect(await ssh.sshConnectionsList()).toEqual([{ hostId: "1", alias: "web", state: { kind: "connected" } }]);
  await ssh.sshDisconnect("1");
  expect(seen.at(-1)).toBe("web:disconnected");
  off();
  await expect(ssh.sshConnect("nope")).rejects.toMatchObject({ code: "not_found" });
});

it("a mock connect to an unreachable host fails with the reason", async () => {
  const ssh = createMockSsh([host("4", "down")]);
  const states: SshConnState[] = [];
  await ssh.onSshState((v) => states.push(v.state));
  await ssh.sshConnect("4");
  await until(() => states.length === 2);
  expect(states[1]).toEqual({ kind: "failed", reason: "unreachable" });
});

it("a mock password host asks, and the answer or a cancel decides the state", async () => {
  const ssh = createMockSsh([host("5", "password-box"), host("6", "password-two")]);
  const prompts: SshAuthPrompt[] = [];
  const closed: string[] = [];
  const states = new Map<string, string>();
  await ssh.onSshAuthPrompt((p) => prompts.push(p));
  await ssh.onSshAuthClosed((id) => closed.push(id));
  await ssh.onSshState((v) => states.set(v.hostId, v.state.kind));
  await ssh.sshConnect("5");
  await ssh.sshConnect("6");
  await until(() => prompts.length === 2);
  expect(prompts[0]).toMatchObject({ hostId: "5", alias: "password-box", kind: "password" });
  await ssh.sshAuthReply(prompts[0].requestId, "s3cret");
  expect(states.get("5")).toBe("connected");
  await ssh.sshAuthReply(prompts[1].requestId, null);
  expect(states.get("6")).toBe("failed");
  expect(closed).toEqual([prompts[0].requestId, prompts[1].requestId]);
  await expect(ssh.sshAuthReply(prompts[0].requestId, "again")).rejects.toMatchObject({ code: "not_found" });
});

it("disconnecting while a prompt is open cancels only that host's prompt", async () => {
  const ssh = createMockSsh([host("5", "password-box"), host("6", "password-two")]);
  const prompts: SshAuthPrompt[] = [];
  const closed: string[] = [];
  const states = new Map<string, string>();
  await ssh.onSshAuthPrompt((p) => prompts.push(p));
  await ssh.onSshAuthClosed((id) => closed.push(id));
  await ssh.onSshState((v) => states.set(v.hostId, v.state.kind));
  await ssh.sshConnect("5");
  await ssh.sshConnect("6");
  await until(() => prompts.length === 2);
  await ssh.sshDisconnect("5");
  expect(closed).toEqual([prompts[0].requestId]);
  expect(states.get("5")).toBe("disconnected");
  expect(states.get("6")).toBe("connecting");
});

it("the mock api carries every SSH connect command", () => {
  const api = createMockApi({});
  for (const name of ["sshHostTest", "sshConnect", "sshDisconnect", "sshConnectionsList", "onSshState", "onSshAuthPrompt", "onSshAuthClosed", "sshAuthReply"] as const) {
    expect(typeof api[name]).toBe("function");
  }
});
