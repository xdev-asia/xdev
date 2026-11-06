import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Button, EmptyState, ListRow, Select, StatusDot, Textarea } from "@xdev-asia/ui";
import type { Api, PeerProject, PeerTerm, PeerView } from "@/api";
import { useProfiles } from "@/agents/profileStore";
import { useI18n } from "@/i18n";
import { pushToast } from "@/workspace/toastStore";
import { openPeerTab } from "./peerTabs";
import { atLeast, errorText, sortPeers, stateTone } from "./peersModel";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The online computers; a row opens that computer. */
export function PeerList(props: { t: T; peers: readonly PeerView[]; onOpen(peer: PeerView): void }): JSX.Element {
  const { t } = props;
  const online = sortPeers(props.peers).filter((p) => p.online);
  if (online.length === 0) return <EmptyState title={t("peers.panel.empty")} />;
  return (
    <ul className="settings-list" aria-label={t("peers.panel.title")}>
      {online.map((p) => (
        <ListRow key={p.id} as="li" title={p.name} meta={t(`peers.role.${p.theirRole ?? "none"}`)} onClick={() => props.onOpen(p)} />
      ))}
    </ul>
  );
}

/** Start an agent on the computer: its project and agent, and a first prompt. Shown only to an Operator or above. */
export function StartAgent(props: {
  t: T;
  computer: string;
  projects: readonly PeerProject[];
  profiles: readonly { id: string; name: string }[];
  busy?: boolean;
  onStart(projectId: string, profileId: string, prompt: string | null): void;
}): JSX.Element {
  const { t } = props;
  const [project, setProject] = useState(props.projects[0]?.id ?? "");
  const [profile, setProfile] = useState(props.profiles[0]?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const chosenProject = props.projects.some((p) => p.id === project) ? project : (props.projects[0]?.id ?? "");
  const chosenProfile = props.profiles.some((p) => p.id === profile) ? profile : (props.profiles[0]?.id ?? "");
  return (
    <div className="peers-stack" role="group" aria-label={t("peers.agent.start", { computer: props.computer })}>
      <h3 className="peers-line">{t("peers.agent.start", { computer: props.computer })}</h3>
      <Select
        aria-label={t("peers.agent.project")}
        value={chosenProject}
        options={props.projects.map((p) => ({ value: p.id, label: p.name }))}
        onChange={(e) => setProject(e.target.value)}
      />
      <Select
        aria-label={t("peers.agent.profile")}
        value={chosenProfile}
        options={props.profiles.map((p) => ({ value: p.id, label: p.name }))}
        onChange={(e) => setProfile(e.target.value)}
      />
      <Textarea label={t("peers.agent.prompt")} rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <Button
        type="button"
        disabled={props.busy || !chosenProject || !chosenProfile}
        onClick={() => props.onStart(chosenProject, chosenProfile, prompt.trim() === "" ? null : prompt.trim())}
      >
        {t("peers.agent.go")}
      </Button>
    </div>
  );
}

/** One computer: its projects and terminals, a Watch on each terminal, and Start agent when we may. */
export function PeerDetail(props: {
  t: T;
  peer: PeerView;
  projects: readonly PeerProject[];
  terms: readonly PeerTerm[];
  profiles: readonly { id: string; name: string }[];
  busy?: boolean;
  onBack(): void;
  onWatch(term: PeerTerm): void;
  onStart(projectId: string, profileId: string, prompt: string | null): void;
}): JSX.Element {
  const { t, peer } = props;
  return (
    <div className="peers-stack">
      <Button type="button" variant="secondary" onClick={props.onBack}>
        {t("peers.panel.back")}
      </Button>
      <h3 className="peers-line">{peer.name}</h3>
      <h4 className="peers-line">{t("peers.panel.projects")}</h4>
      {props.projects.length === 0 ? (
        <p className="peers-line">{t("peers.panel.noProjects", { name: peer.name })}</p>
      ) : (
        <ul className="settings-list">
          {props.projects.map((p) => (
            <ListRow key={p.id} as="li" title={p.name} meta={p.path ?? undefined} />
          ))}
        </ul>
      )}
      <h4 className="peers-line">{t("peers.panel.terminals")}</h4>
      {props.terms.length === 0 ? (
        <p className="peers-line">{t("peers.panel.noTerminals", { name: peer.name })}</p>
      ) : (
        <ul className="settings-list">
          {props.terms.map((term) => (
            <ListRow
              key={term.id}
              as="li"
              title={term.title}
              meta={term.agent ? `${term.agent} · ${t(`peers.agentState.${term.state}`)}` : t(`peers.agentState.${term.state}`)}
              leading={term.agent ? <StatusDot tone={stateTone(term.state)} label={t(`peers.agentState.${term.state}`)} /> : undefined}
              trailing={
                <Button type="button" variant="secondary" aria-label={t("peers.term.watchTab", { tab: term.title })} onClick={() => props.onWatch(term)}>
                  {t("peers.term.watch")}
                </Button>
              }
            />
          ))}
        </ul>
      )}
      {atLeast(peer.theirRole, "operator") && props.projects.length > 0 && (
        <StartAgent t={t} computer={peer.name} projects={props.projects} profiles={props.profiles} busy={props.busy} onStart={props.onStart} />
      )}
    </div>
  );
}

/** The content of the Computers popover: the online computers, and one of them opened. */
export function ComputersPanel(props: { api: Api; peers: readonly PeerView[]; onClose?: () => void }): JSX.Element {
  const { api } = props;
  const { t } = useI18n();
  const { view } = useProfiles();
  const [openId, setOpenId] = useState<string | null>(null);
  const [projects, setProjects] = useState<PeerProject[]>([]);
  const [terms, setTerms] = useState<PeerTerm[]>([]);
  const [busy, setBusy] = useState(false);
  const peer = props.peers.find((p) => p.id === openId && p.online) ?? null;

  useEffect(() => {
    if (!peer) return;
    let stale = false;
    const failed = (e: unknown) => pushToast({ text: errorText(t, e, peer.name) });
    api.peerProjects(peer.id).then((l) => !stale && setProjects(l), failed);
    api.peerTerms(peer.id).then((l) => !stale && setTerms(l), failed);
    return () => {
      stale = true;
    };
    // The lists load when a computer is opened, not on every change of the words.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, peer?.id]);

  if (!peer) return <PeerList t={t} peers={props.peers} onOpen={(p) => (setProjects([]), setTerms([]), setOpenId(p.id))} />;
  const profiles = (view?.profiles ?? []).map((p) => ({ id: p.profile.id, name: p.profile.name }));
  return (
    <PeerDetail
      t={t}
      peer={peer}
      projects={projects}
      terms={terms}
      profiles={profiles}
      busy={busy}
      onBack={() => setOpenId(null)}
      onWatch={(term) => {
        openPeerTab(peer, term);
        props.onClose?.();
      }}
      onStart={(projectId, profileId, prompt) => {
        setBusy(true);
        api.peerAgentStart(peer.id, projectId, profileId, prompt).then(
          (term) => {
            setBusy(false);
            setTerms((l) => [...l.filter((x) => x.id !== term.id), term]);
          },
          (e: unknown) => {
            setBusy(false);
            pushToast({ text: errorText(t, e, peer.name) });
          },
        );
      }}
    />
  );
}
