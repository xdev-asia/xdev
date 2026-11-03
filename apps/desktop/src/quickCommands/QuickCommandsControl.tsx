import { useEffect, useState } from "react";
import type { JSX } from "react";
import { profileName, useProfiles } from "@/agents/profileStore";
import type { Api, FileCommands } from "@/api";
import { useI18n } from "@/i18n";
import { TrustDialog } from "@/workspace/TrustDialog";
import type { Sessions, Tab } from "@/workspace/sessions";
import type { Env, Row } from "./model";
import { QuickCommandsButton } from "./QuickCommandsButton";
import { QuickCommandsPopover } from "./QuickCommandsPopover";
import { QuickCommandDialog, type RepoChoice } from "./QuickCommandDialog";
import { runWithToast } from "./runUi";
import { trustFileCommands, useQuickCommands } from "./store";

/** What the trust dialog shows: every command of the file as the person would run it. */
export function fileCommandsText(file: FileCommands): string {
  return file.commands
    .map((c) => (c.action.type === "agent" ? `${c.label} [agent ${c.action.profile}]\n  ${c.action.prompt}` : `${c.label}\n  ${c.action.command}`))
    .join("\n\n");
}

/**
 * The Command button of a tab strip, with its popover and the trust dialog. `tab` is the tab a
 * terminal command is typed into (the front tab of this strip's pane).
 */
export function QuickCommandsControl(props: {
  api: Api;
  sessions: Sessions;
  worktree: string;
  /** The repo registry key (its path) the worktree belongs to; null when unknown. */
  repo: string | null;
  repoName: string;
  tab: Tab | null;
  /** A new value opens the popover (the `quickCommands.open` key and the palette). */
  openSeq?: number;
  onFocus?(tab: Tab): void;
  onManage(): void;
}): JSX.Element {
  const { api, sessions, worktree, tab } = props;
  const { t } = useI18n();
  const { view } = useProfiles();
  const [open, setOpen] = useState(false);
  const [trusting, setTrusting] = useState<{ hash: string; text: string; busy: boolean } | null>(null);
  const [creating, setCreating] = useState<RepoChoice[] | null>(null);
  const q = useQuickCommands(api, props.repo, worktree);

  const [seen, setSeen] = useState(props.openSeq ?? 0);
  useEffect(() => {
    if (props.openSeq !== undefined && props.openSeq !== seen) {
      setSeen(props.openSeq);
      setOpen(true);
    }
  }, [props.openSeq, seen]);

  const live = tab !== null && tab.exitCode === undefined ? tab : null;
  const env: Env = { hasTerminal: live !== null, profiles: view ? view.profiles.map((p) => p.profile.id) : null };

  async function run(row: Row, appendEnter?: false): Promise<void> {
    setOpen(false);
    await runWithToast(
      api,
      row.cmd,
      {
        sessions,
        worktree,
        tab: live,
        appendEnter,
        trusted: q.file?.trusted,
        profiles: env.profiles ?? undefined,
        focus: props.onFocus,
      },
      t,
    );
  }

  async function trust(): Promise<void> {
    if (!trusting) return;
    setTrusting({ ...trusting, busy: true });
    const ok = await trustFileCommands(api, worktree, trusting.hash);
    setTrusting(ok ? null : { ...trusting, busy: false });
  }

  return (
    <>
      <QuickCommandsButton open={open} onOpen={setOpen}>
        <QuickCommandsPopover
          sel={q}
          file={q.file}
          env={env}
          repoName={props.repoName}
          target={{ name: live ? (live.title ?? profileName(view, live.profileId, t)) : null, agent: live?.agent ?? false }}
          onRun={(row, appendEnter) => void run(row, appendEnter)}
          onTrust={() => {
            if (!q.file) return;
            setOpen(false);
            setTrusting({ hash: q.file.hash, text: fileCommandsText(q.file), busy: false });
          }}
          onNew={() => {
            setOpen(false);
            void api.workspaceList().then(
              (rs) => setCreating(rs.filter((r) => !r.missing).map((r) => ({ path: r.path, name: r.shortName }))),
              () => setCreating([]),
            );
          }}
          onManage={() => {
            setOpen(false);
            props.onManage();
          }}
          onClose={() => setOpen(false)}
        />
      </QuickCommandsButton>
      {creating && (
        <QuickCommandDialog
          api={api}
          initial={null}
          defaultRepo={props.repo}
          repos={creating}
          profiles={view ? view.profiles.map((p) => ({ id: p.profile.id, name: p.profile.name })) : []}
          onSaved={() => setCreating(null)}
          onCancel={() => setCreating(null)}
        />
      )}
      {trusting && (
        <TrustDialog
          repo={props.repoName}
          file="xdev.toml"
          kind="commands"
          text={trusting.text}
          changed={false}
          busy={trusting.busy}
          onTrust={() => void trust()}
          onCancel={() => setTrusting(null)}
        />
      )}
    </>
  );
}
