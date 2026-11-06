import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PeerProject, PeerTerm, PeerView } from "@/api";
import { translate } from "@/i18n";
import { PeerDetail, PeerList } from "./ComputersPanel";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const peer = (over: Partial<PeerView> = {}): PeerView => ({ id: "studio-mac", name: "studio-mac", kind: "desktop", role: "viewer", theirRole: "operator", online: true, lastSeenMs: 0, sameXdevId: false, ...over });
const projects: PeerProject[] = [{ id: "app", name: "app", path: null }];
const terms: PeerTerm[] = [
  { id: "review", title: "review", agent: "reviewer", state: "idle", projectId: "app" },
  { id: "shell", title: "shell", agent: null, state: "running", projectId: "app" },
];
const detail = (p: PeerView, t: readonly PeerTerm[] = terms) =>
  renderToStaticMarkup(
    <PeerDetail t={en} peer={p} projects={projects} terms={t} profiles={[{ id: "claude", name: "Claude" }]} onBack={() => {}} onWatch={() => {}} onStart={() => {}} />,
  );

it("lists the terminals with a Watch on each, and Start agent for an Operator", () => {
  const html = detail(peer());
  expect(html).toContain("review");
  expect(html).toContain(en("peers.term.watchTab", { tab: "review" }));
  expect(html).toContain(en("peers.term.watchTab", { tab: "shell" }));
  expect(html).toContain(en("peers.agent.start", { computer: "studio-mac" }));
});

it("hides Start agent from a Viewer, and from a computer that gave us nothing", () => {
  expect(detail(peer({ theirRole: "viewer" }))).not.toContain(en("peers.agent.start", { computer: "studio-mac" }));
  expect(detail(peer({ theirRole: null }))).not.toContain(en("peers.agent.start", { computer: "studio-mac" }));
  expect(detail(peer({ theirRole: "viewer" }))).toContain(en("peers.term.watchTab", { tab: "review" }));
});

it("says so when no terminal is open", () => {
  expect(detail(peer(), [])).toContain(en("peers.panel.noTerminals", { name: "studio-mac" }));
});

it("lists only the online computers, and says so when none is", () => {
  const html = renderToStaticMarkup(<PeerList t={en} peers={[peer(), peer({ id: "off", name: "sleeper", online: false })]} onOpen={() => {}} />);
  expect(html).toContain("studio-mac");
  expect(html).not.toContain("sleeper");
  expect(renderToStaticMarkup(<PeerList t={en} peers={[peer({ online: false })]} onOpen={() => {}} />)).toContain(en("peers.panel.empty"));
});
