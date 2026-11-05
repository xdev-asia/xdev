import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Button, EmptyState, Icon, SearchInput, Toolbar, type MenuEntry } from "@xdev-asia/ui";
import { type Api, type Automation, type AutomationRun, type AutomationsView, type ProfilesView, type RepoView, toApiError } from "@/api";
import { useI18n } from "@/i18n";
import { pushToast } from "@/workspace/toastStore";
import { useAutomationsSettings } from "@/settings/automationsSettings";
import { AutomationDetail } from "./AutomationDetail";
import { AutomationEditorDialog } from "./AutomationEditorDialog";
import { AutomationList, type RowAction } from "./AutomationList";
import { AutomationRunDetails } from "./AutomationRunDetails";
import { DeleteAutomationDialog, deleteAutomation } from "./DeleteAutomationDialog";
import { MenuButton } from "./MenuButton";
import { TemplateEmptyState } from "./TemplateEmptyState";
import { NO_QUERY, nextSort, visibleRows, type LastRunFilter, type ListQuery, type SortKey } from "./listModel";
import { label as scheduleLabel } from "./schedule";
import type { AutomationTemplate } from "./templates";

const LAST_RUN: readonly LastRunFilter[] = ["all", "succeeded", "failed", "never"];

/** The Automations view: the list with its toolbar, the detail pane of the selected one, and their runs. */
export function AutomationsPage(props: {
  api: Api;
  repos: readonly RepoView[] | null;
  /** The clock; the list's ages are drawn against it. */
  now?: () => number;
  /** Opens a Settings section (the delete toast points at Automations). */
  openSettings?(section: string): void;
  /** Shows a worktree in the workspace view. */
  onOpenWorkspace?(path: string): void;
}): JSX.Element {
  const i18n = useI18n();
  const { t } = i18n;
  const { api } = props;
  const [data, setData] = useState<AutomationsView | null>(null);
  const [profiles, setProfiles] = useState<ProfilesView | null>(null);
  const [query, setQuery] = useState<ListQuery>(NO_QUERY);
  const [selected, setSelected] = useState<string | null>(null);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [schedules, setSchedules] = useState<Record<string, string>>({});
  const [tick, setTick] = useState(0);
  const [editing, setEditing] = useState<{ automation: Automation | null; template: AutomationTemplate | null } | null>(null);
  const [deleting, setDeleting] = useState<Automation | null>(null);
  const [picking, setPicking] = useState(false);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const settings = useAutomationsSettings();
  const now = (props.now ?? Date.now)();

  const reload = () => setTick((n) => n + 1);

  // The list and its schedules; again whenever the backend says something changed.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const view = await api.automationsList();
        if (!alive) return;
        setData(view);
        const labels: Record<string, string> = {};
        await Promise.all(
          view.automations.map(async (a) => {
            try {
              labels[a.id] = scheduleLabel(await api.automationDescribe(a.rrule, a.timezone), i18n);
            } catch {
              labels[a.id] = t("automations.schedule.invalid");
            }
          }),
        );
        if (alive) setSchedules(labels);
      } catch {
        if (alive) setData({ automations: [], lastRuns: [] });
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, tick, i18n.locale]);

  useEffect(() => {
    const off = api.onAutomationsChanged(() => reload());
    return () => void off.then((stop) => stop()).catch(() => {});
  }, [api]);

  useEffect(() => {
    void api.profiles().then(setProfiles).catch(() => {});
  }, [api]);

  // The runs of the selected automation.
  useEffect(() => {
    if (selected === null) return void setRuns([]);
    let alive = true;
    void api.automationRuns(selected).then((r) => alive && setRuns(r)).catch(() => alive && setRuns([]));
    return () => {
      alive = false;
    };
  }, [api, selected, tick]);

  const repoName = (repoId: string) => props.repos?.find((r) => r.id === repoId)?.shortName ?? t("automations.list.projectGone");
  const automations = data?.automations ?? [];
  const view = useMemo(() => visibleRows(automations, data?.lastRuns ?? [], repoName, query), [data, query, props.repos]);
  const current = automations.find((a) => a.id === selected) ?? null;
  const agentName = (id: string) => profiles?.profiles.find((p) => p.profile.id === id)?.profile.name ?? id;
  const worktreeExists = (path: string) => props.repos?.some((r) => r.worktrees.some((w) => w.path === path)) ?? false;
  const agents = profiles?.profiles.filter((p) => p.profile.enabled) ?? [];

  async function remove(a: Automation, dontAsk: boolean): Promise<void> {
    try {
      await deleteAutomation(api, a, { dontAsk, openSettings: (section) => props.openSettings?.(section), t });
      if (selected === a.id) setSelected(null);
      reload();
    } catch (e) {
      pushToast({ text: t("automations.toast.changeFailed", { code: toApiError(e).code }) });
    }
  }

  async function act(a: Automation, action: RowAction): Promise<void> {
    if (action === "edit") return setEditing({ automation: a, template: null });
    if (action === "delete") return settings.skipDeleteConfirm ? void remove(a, false) : setDeleting(a);
    try {
      if (action === "run") {
        await api.automationRunNow(a.id);
        pushToast({ text: t("automations.toast.runQueued") });
      } else if (action === "toggle") {
        await api.automationSetEnabled(a.id, !a.enabled);
        pushToast({ text: t(a.enabled ? "automations.toast.paused" : "automations.toast.resumed") });
      }
      reload();
    } catch (e) {
      if (action === "run" && toApiError(e).detail === "previousRunActive") return void pushToast({ text: t("automations.toast.runActive") });
      pushToast({ text: t(action === "run" ? "automations.toast.runFailed" : "automations.toast.changeFailed", { code: toApiError(e).code }) });
    }
  }

  const filterItems: MenuEntry[] = [
    { type: "group", label: t("automations.filters.agent") },
    { label: t("automations.filters.agent.all"), checked: query.agent === null, onSelect: () => setQuery({ ...query, agent: null }) },
    ...agents.map((p): MenuEntry => ({ label: p.profile.name, checked: query.agent === p.profile.id, onSelect: () => setQuery({ ...query, agent: p.profile.id }) })),
    { type: "separator" },
    { type: "group", label: t("automations.filters.lastRun") },
    ...LAST_RUN.map((value): MenuEntry => ({ label: t(`automations.filters.lastRun.${value}`), checked: query.lastRun === value, onSelect: () => setQuery({ ...query, lastRun: value }) })),
    { type: "separator" },
    { label: t("automations.filters.clear"), disabled: !view.filtersOn, onSelect: () => setQuery({ ...query, agent: null, lastRun: "all" }) },
  ];

  const toolbar = (
    <Toolbar
      title={t("automations.title")}
      actions={
        <>
          <SearchInput
            size="sm"
            value={query.search}
            placeholder={t("automations.search.placeholder")}
            aria-label={t("automations.search.label")}
            labels={{ search: t("automations.search.label"), clear: t("automations.search.clear") }}
            onChange={(e) => setQuery({ ...query, search: e.target.value })}
            onClear={() => setQuery({ ...query, search: "" })}
          />
          <MenuButton label={t("automations.filters")} items={filterItems} action="filters">
            <Icon name="sliders" size={14} /> {t("automations.filters")}
          </MenuButton>
          <button type="button" className="ws-icon-btn" data-act="refresh" aria-label={t("automations.refresh")} title={t("automations.refresh")} onClick={reload}>
            <Icon name="restore" size={14} />
          </button>
          <Button variant="secondary" data-act="templates" icon="plus" aria-pressed={picking} onClick={() => setPicking(!picking)}>
            {t("automations.fromTemplate")}
          </Button>
          <Button variant="primary" data-act="new" icon="plus" onClick={() => setEditing({ automation: null, template: null })}>
            {t("automations.new")}
          </Button>
        </>
      }
    />
  );

  let body: JSX.Element;
  if (data === null) body = <p className="au-empty" role="status" />;
  else if (automations.length === 0 || picking) {
    body = (
      <TemplateEmptyState
        onPick={(template) => {
          setPicking(false);
          setEditing({ automation: null, template });
        }}
      />
    );
  }
  else if (view.rows.length === 0) body = <EmptyState title={t(view.filtersOn ? "automations.list.empty.filters" : "automations.list.empty.search")} />;
  else {
    body = (
      <AutomationList
        rows={view.rows}
        sort={query.sort}
        onSort={(key: SortKey) => setQuery({ ...query, sort: nextSort(query.sort, key) })}
        selected={selected}
        onSelect={(id) => {
          setPicking(false);
          setSelected(id);
        }}
        onAction={(id, action) => {
          const a = automations.find((x) => x.id === id);
          if (a) void act(a, action);
        }}
        schedules={schedules}
        now={now}
      />
    );
  }

  const openRun = openRunId === null ? null : (runs.find((r) => r.id === openRunId) ?? null);
  const dialogs = (
    <>
      {editing && (
        <AutomationEditorDialog
          api={api}
          repos={props.repos ?? []}
          agents={profiles?.profiles.map((p) => ({ id: p.profile.id, name: p.profile.name, enabled: p.profile.enabled, installed: p.installed })) ?? []}
          defaultAgent={profiles?.defaultAgent ?? "claude"}
          defaultRepo={current?.repoId ?? props.repos?.find((r) => !r.missing)?.id ?? ""}
          automation={editing.automation}
          template={editing.template}
          onSaved={(saved) => {
            setEditing(null);
            setSelected(saved.id);
            reload();
          }}
          onCancel={() => setEditing(null)}
        />
      )}
      <DeleteAutomationDialog
        automation={deleting}
        onConfirm={(dontAsk) => {
          const a = deleting;
          setDeleting(null);
          if (a) void remove(a, dontAsk);
        }}
        onCancel={() => setDeleting(null)}
      />
    </>
  );

  if (openRun) {
    return (
      <section className="au-page" aria-label={t("automations.page.label")}>
        <AutomationRunDetails
          run={openRun}
          automation={automations.find((a) => a.id === openRun.automationId) ?? null}
          exists={worktreeExists}
          now={now}
          onBack={() => setOpenRunId(null)}
          onRerun={() => {
            const a = automations.find((x) => x.id === openRun.automationId);
            if (!a) return;
            setOpenRunId(null);
            void act(a, "run");
          }}
          onOpenWorkspace={(path) => props.onOpenWorkspace?.(path)}
        />
        {dialogs}
      </section>
    );
  }

  return (
    <section className="au-page" aria-label={t("automations.page.label")}>
      {toolbar}
      {view.tooLong && (
        <p className="au-note" role="status">
          {t("automations.search.tooLong")}
        </p>
      )}
      <div className="au-split">
        <div className="au-main">{body}</div>
        {current ? (
          <AutomationDetail
            automation={current}
            schedule={schedules[current.id] ?? ""}
            project={repoName(current.repoId)}
            agentName={agentName(current.agent)}
            runs={runs}
            exists={worktreeExists}
            onOpenRun={(run) => setOpenRunId(run.id)}
          />
        ) : (
          automations.length > 0 && <p className="au-empty au-detail-empty">{t("automations.detail.empty")}</p>
        )}
      </div>
      {dialogs}
    </section>
  );
}
