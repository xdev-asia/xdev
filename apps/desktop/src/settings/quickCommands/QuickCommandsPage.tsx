import { Button } from "@xdev-asia/ui";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import { useProfiles } from "@/agents/profileStore";
import { toApiError, type ApiError, type QuickCommand, type RepoView } from "@/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useI18n } from "@/i18n";
import { duplicateOf } from "@/quickCommands/form";
import { badgeOf, oneLine, textOf } from "@/quickCommands/model";
import { QuickCommandDialog } from "@/quickCommands/QuickCommandDialog";
import { getQuickCommands, loadFileCommands, startQuickCommands, subscribeQuickCommands } from "@/quickCommands/store";
import { SettingRow } from "../SettingRow";
import type { SettingsSectionProps } from "../sections";
import { buildGroups, moveTarget, type Group, type RepoOption } from "./pageModel";

/** Where a repo's `xdev.toml` is read from: its first worktree, else the repo itself. */
const worktreeOf = (r: RepoView): string => r.worktrees[0]?.path ?? r.path;

/** Settings › Quick Commands: the saved commands by scope, and the read-only ones from `xdev.toml`. */
export function QuickCommandsPage(props: SettingsSectionProps): JSX.Element {
  const { api } = props;
  const { t } = useI18n();
  const { view } = useProfiles();
  const state = useSyncExternalStore(subscribeQuickCommands, getQuickCommands, getQuickCommands);
  const [repoViews, setRepoViews] = useState<RepoView[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [editing, setEditing] = useState<{ item: QuickCommand | null } | null>(props.arg === "new" ? { item: null } : null);
  const [deleting, setDeleting] = useState<QuickCommand | null>(null);
  const [error, setError] = useState<ApiError["code"]>();

  // The window starts the store; this keeps the page current when it is opened on its own.
  useEffect(() => startQuickCommands(api), [api]);
  useEffect(() => {
    api.workspaceList().then(setRepoViews, () => {});
  }, [api]);
  useEffect(() => {
    for (const r of repoViews) if (!r.missing) void loadFileCommands(api, worktreeOf(r));
  }, [api, repoViews]);

  const repos: RepoOption[] = useMemo(() => repoViews.filter((r) => !r.missing).map((r) => ({ path: r.path, name: r.shortName })), [repoViews]);
  const files = useMemo(() => Object.fromEntries(repoViews.map((r) => [r.path, state.files[worktreeOf(r)]])), [repoViews, state.files]);
  const groups = buildGroups(state.items, repos, files, query, filter);
  const profiles = view ? view.profiles.map((p) => ({ id: p.profile.id, name: p.profile.name })) : [];

  async function act(run: () => Promise<unknown>): Promise<void> {
    setError(undefined);
    try {
      await run();
    } catch (e) {
      setError(toApiError(e).code);
    }
  }

  const title = (g: Group): string => {
    switch (g.kind) {
      case "global":
        return t("qcmd.section.global");
      case "repo":
        return t("qcmd.page.repoGroup", { repo: g.repo.name });
      case "unknown":
        return t("qcmd.page.unknownRepo");
      case "file":
        return t("qcmd.page.fileGroup", { repo: g.repo.name });
    }
  };

  function confirmDelete(): void {
    const cmd = deleting;
    setDeleting(null);
    if (cmd) void act(() => api.quickCommandDelete(cmd.id));
  }

  const rowOf = (c: QuickCommand, g: Extract<Group, { items: QuickCommand[] }>): JSX.Element => {
    const up = moveTarget(state.items, c.id, -1);
    const down = moveTarget(state.items, c.id, 1);
    const gone = g.kind === "unknown";
    return (
      <li key={c.id} className="settings-item qc-page-row" data-testid="qc-row">
        <div className="settings-item-text">
          <strong>{c.label}</strong>
          <span className="qc-page-detail">
            <span className="qc-badge" data-badge={badgeOf(c.action)}>
              {t(`qcmd.badge.${badgeOf(c.action)}`)}
            </span>
            <span className="ws-mono settings-path">{oneLine(textOf(c.action))}</span>
          </span>
        </div>
        <div className="qc-page-actions">
          {!gone && (
            <>
              <button type="button" className="btn-secondary" aria-label={t("qcmd.page.moveUp")} disabled={up === null} onClick={() => up !== null && void act(() => api.quickCommandsMove(c.id, up))}>
                ↑
              </button>
              <button type="button" className="btn-secondary" aria-label={t("qcmd.page.moveDown")} disabled={down === null} onClick={() => down !== null && void act(() => api.quickCommandsMove(c.id, down))}>
                ↓
              </button>
              <button type="button" className="btn-secondary" onClick={() => setEditing({ item: c })}>
                {t("qcmd.page.edit")}
              </button>
              <button type="button" className="btn-secondary" onClick={() => void act(() => api.quickCommandUpsert(duplicateOf(c, t("qcmd.page.copySuffix"))))}>
                {t("qcmd.page.duplicate")}
              </button>
            </>
          )}
          <button type="button" className="btn-secondary" onClick={() => setDeleting(c)}>
            {t("qcmd.page.delete")}
          </button>
        </div>
      </li>
    );
  };

  return (
    <div className="settings-page qc-page">
      <header className="settings-head">
        <h3>{t("qcmd.title")}</h3>
        <p>{t("qcmd.page.intro")}</p>
      </header>
      {error && (
        <p className="error-text" role="alert">
          {t(`error.${error}`)}
        </p>
      )}
      <SettingRow id="qcmd.page" filter={props.filter}>
      <div className="qc-page-tools">
        <input type="search" className="qc-search" aria-label={t("qcmd.search")} placeholder={t("qcmd.search")} value={query} onChange={(e) => setQuery(e.target.value)} />
        <select aria-label={t("qcmd.page.filter")} value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">{t("qcmd.page.filterAll")}</option>
          <option value="global">{t("qcmd.section.global")}</option>
          {repos.map((r) => (
            <option key={r.path} value={r.path}>
              {r.name}
            </option>
          ))}
        </select>
        <Button type="button" onClick={() => setEditing({ item: null })}>
          {t("qcmd.new")}
        </Button>
      </div>

      {groups.length === 0 && <p className="settings-empty">{t(state.items.length === 0 ? "qcmd.empty" : "qcmd.noMatch")}</p>}
      {groups.map((g) => (
        <section key={g.id} aria-label={title(g)} data-group={g.kind}>
          <h4 className="settings-group">{title(g)}</h4>
          {g.kind === "file" ? (
            <>
              <p className="settings-hint">
                {t(g.file.trusted ? "qcmd.page.trusted" : "qcmd.notTrusted")} {t("qcmd.page.readOnly")}
              </p>
              <ul className="settings-list">
                {g.file.commands.map((c, i) => (
                  <li key={`${i}:${c.label}`} className="settings-item qc-page-row" data-testid="qc-file-row">
                    <div className="settings-item-text">
                      <strong>{c.label}</strong>
                      <span className="qc-page-detail">
                        <span className="qc-badge" data-badge={badgeOf(c.action)}>
                          {t(`qcmd.badge.${badgeOf(c.action)}`)}
                        </span>
                        <span className="ws-mono settings-path">{oneLine(textOf(c.action))}</span>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
              {g.file.errors.map((e) => (
                <p key={e} className="error-text">
                  {e}
                </p>
              ))}
            </>
          ) : (
            <ul className="settings-list">{g.items.map((c) => rowOf(c, g))}</ul>
          )}
        </section>
      ))}
      </SettingRow>

      {editing && (
        <QuickCommandDialog
          api={api}
          initial={editing.item}
          defaultRepo={filter !== "all" && filter !== "global" ? filter : null}
          repos={repos}
          profiles={profiles}
          onSaved={() => setEditing(null)}
          onCancel={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title={t("qcmd.page.deleteTitle")}
        body={t("qcmd.page.deleteBody", { label: deleting?.label ?? "" })}
        confirmLabel={t("qcmd.page.delete")}
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
