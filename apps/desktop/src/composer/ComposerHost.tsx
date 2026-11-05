import { IconButton } from "@xdev-asia/ui";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import type { Api } from "@/api";
import { profileName } from "@/agents/profileStore";
import { useI18n } from "@/i18n";
import { useKeymap } from "@/keys/keymap";
import type { Sessions, Tab } from "@/workspace/sessions";
import { Composer, type ComposerTab } from "./Composer";
import { verifiedSend, type SendResult } from "./verify";

/** A request to open the composer over several worktrees' tabs (the bulk bar); a new `seq` is a new one. */
export type ComposerRequest = { worktrees: readonly string[]; seq: number };

const NO_SESSIONS = () => () => {};
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const live = (tab: Tab | null | undefined): tab is Tab => !!tab && !tab.asleep && tab.exitCode === undefined;

/** Types `text` into the tab `id` and watches it for a reply (see `verify.ts`). */
export function sendToTab(sessions: Sessions, id: string, text: string): Promise<SendResult> {
  const tab = sessions.tab(id);
  if (!live(tab)) return Promise.resolve("failed");
  return verifiedSend(text, tab.agent, {
    write: (data) => tab.client.input(data),
    lastOutput: () => sessions.lastOutput(id),
    now: () => Date.now(),
    sleep,
  });
}

/**
 * Owns the composer: the `composer.open` key, the button that opens it over the focused terminal
 * tab, and the bulk bar's Send prompt. The composer is bound to the terminal tab in front.
 */
export function ComposerHost(props: {
  api: Api;
  sessions: Sessions | null;
  /** The front tab of the worktree on screen; null when none. */
  shownTab: string | null;
  /** Worktree names by path, for tab labels. */
  names: Readonly<Record<string, string>>;
  /** False while another view or a modal dialog is up. */
  active: boolean;
  request: ComposerRequest | null;
}): JSX.Element | null {
  const { api, sessions } = props;
  const { t } = useI18n();
  const snapshot = () => (sessions ? versionOf(sessions) : "");
  useSyncExternalStore((cb) => (sessions ? sessions.subscribe(cb) : NO_SESSIONS()), snapshot, snapshot);
  const [open, setOpen] = useState<{ many: string[] | null; seq: number } | null>(null);
  // The tab the composer stays on while the front tab is not a terminal.
  const bound = useRef<string | null>(null);

  const tabs: ComposerTab[] = sessions
    ? sessions.worktrees().flatMap((w) =>
        sessions.tabs(w).filter(live).map((tab) => ({
          id: tab.id,
          worktree: tab.worktree,
          agent: tab.agent,
          label: `${tab.title ?? profileName(null, tab.profileId, t)} · ${props.names[tab.worktree] ?? tab.worktree.split(/[\\/]/).filter(Boolean).pop() ?? tab.worktree}`,
        })),
      )
    : [];
  const front = tabs.find((x) => x.id === props.shownTab) ?? null;
  if (front) bound.current = front.id;
  const target = front ?? tabs.find((x) => x.id === bound.current) ?? null;

  useKeymap({
    "composer.open": () => {
      if (!props.active || !target) return false;
      setOpen((o) => (o ? null : { many: null, seq: 0 }));
    },
  });

  const seq = props.request?.seq;
  useEffect(() => {
    if (!props.request || !sessions) return;
    const wanted = new Set(props.request.worktrees);
    setOpen({ many: tabs.filter((x) => wanted.has(x.worktree)).map((x) => x.id), seq: props.request.seq });
    // Only a new request opens it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq]);

  if (!sessions || !props.active || !target) return null;
  // The launcher stays while the panel is open, so focus has a place to go back to on close.
  return (
    <>
      <div className="composer-launch">
        <IconButton
          icon="prompt"
          label={t("composer.open")}
          aria-expanded={open !== null}
          onClick={() => setOpen((o) => (o ? null : { many: null, seq: 0 }))}
          data-testid="composer-launch"
        />
      </div>
      {open && (
        <Composer
          key={open.seq}
          api={api}
          target={target}
          tabs={tabs}
          initialMany={open.many}
          send={(id, text) => sendToTab(sessions, id, text)}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

// A key that changes whenever a tab opens, closes, sleeps, exits or is renamed.
function versionOf(sessions: Sessions): string {
  return sessions
    .worktrees()
    .flatMap((w) => sessions.tabs(w).map((x) => `${x.id}:${x.title ?? ""}:${x.asleep ? 1 : 0}:${x.exitCode === undefined ? "" : "x"}`))
    .join("|");
}
