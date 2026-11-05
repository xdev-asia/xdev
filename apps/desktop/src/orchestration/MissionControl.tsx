import { Button, Dialog, Disclosure, Field, Select, StatusDot, Switch, Tabs, Tag, Textarea } from "@xdev-asia/ui";
import type { SessionState } from "@xdev-asia/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type LinkGrant, type MissionTab, type MissionView, type TabLink } from "@/api";
import { useI18n } from "@/i18n";
import { ago } from "@/workspace/ago";
import { missionOrder, stuckReason } from "./stuck";
import { TeamMap } from "./TeamMap";
import "./orchestration.css";

export type MissionApi = Pick<
  Api,
  | "orchestrationMission"
  | "orchestrationMissionSettingsPut"
  | "orchestrationLinkPut"
  | "orchestrationLinkGrant"
  | "orchestrationLinkRetarget"
  | "orchestrationLinkRemove"
  | "orchestrationNudge"
  | "orchestrationTabStop"
>;

export interface MissionControlProps {
  api: MissionApi;
  view: "tabs" | "map";
  onView(view: "tabs" | "map"): void;
  onClose(): void;
  /** Brings the tab to the front of the workspace. */
  onFocusTab(id: string): void;
  /** Opens the hand-off dialog from this tab. */
  onHandoff(from: string): void;
  /** How often the list is read again. */
  pollMs?: number;
}

const POLL_MS = 5_000;

/** The dot a reported status shows. */
export function dotState(t: Pick<MissionTab, "status" | "exited">): SessionState {
  if (t.exited) return "exited";
  if (t.status === "working") return "working";
  if (t.status === "needs-you") return "waiting";
  if (t.status === "done") return "done";
  return "idle";
}

/** A tab's name: its title, else its id. */
export function tabName(t: Pick<MissionTab, "id" | "title">): string {
  return t.title?.trim() || t.id;
}

/** Every worker and linked tab with its status, last activity, task and links; nudge, relink, focus and stop. */
export function MissionControl(props: MissionControlProps): JSX.Element {
  const { api, view, onView, onClose, onFocusTab, onHandoff } = props;
  const { t } = useI18n();
  const [data, setData] = useState<MissionView | null>(null);
  const [failed, setFailed] = useState(false);
  const [status, setStatus] = useState("");
  const [stopping, setStopping] = useState<string | null>(null);
  const [minutes, setMinutes] = useState("");
  const [nudgeText, setNudgeText] = useState("");

  const load = useCallback(async () => {
    try {
      const v = await api.orchestrationMission();
      setData(v);
      setFailed(false);
      return v;
    } catch {
      setFailed(true);
      return null;
    }
  }, [api]);

  useEffect(() => {
    let live = true;
    void load().then((v) => {
      if (live && v) {
        setMinutes(String(v.settings.stuckMinutes));
        setNudgeText(v.settings.nudgePrompt);
      }
    });
    const timer = setInterval(() => void load(), props.pollMs ?? POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [load, props.pollMs]);

  const tabs = data?.tabs ?? [];
  const links = data?.links ?? [];
  const now = data?.nowMs ?? Date.now();
  const stuckMinutes = data?.settings.stuckMinutes ?? 10;
  const byId = new Map(tabs.map((x) => [x.id, x]));
  const name = (id: string) => {
    const tab = byId.get(id);
    return tab ? tabName(tab) : id;
  };
  const linked = new Set(links.flatMap((l) => [l.from, l.to]));
  const rows = missionOrder(tabs, linked, now, stuckMinutes);
  const stuckCount = rows.filter((r) => stuckReason(r, now, stuckMinutes)).length;

  async function act(run: () => Promise<unknown>, done: string): Promise<void> {
    try {
      await run();
      setStatus(done);
    } catch (e) {
      const err = toApiError(e);
      setStatus(err.detail ? t("mission.failedWith", { detail: err.detail }) : t("mission.failed"));
    }
    await load();
  }

  const nudge = (tab: MissionTab) => act(() => api.orchestrationNudge(tab.id), t("mission.nudged", { name: tabName(tab) }));
  const linkTo = (from: string, to: string) => act(() => api.orchestrationLinkPut(from, to), t("mission.linked", { from: name(from), to: name(to) }));
  const relink = (l: TabLink, to: string) =>
    act(() => api.orchestrationLinkRetarget(l.from, l.to, to), t("mission.relinked", { from: name(l.from), to: name(to) }));
  const unlink = (l: TabLink) => act(() => api.orchestrationLinkRemove(l.from, l.to), t("mission.unlinked", { from: name(l.from), to: name(l.to) }));
  const grant = (l: TabLink, g: LinkGrant, on: boolean) =>
    act(
      () => api.orchestrationLinkGrant(l.from, l.to, g, on),
      t(on ? "mission.grantOn" : "mission.grantOff", { grant: t(`mission.grant.${g}`), from: name(l.from), to: name(l.to) }),
    );
  function stop(tab: MissionTab): void {
    if (stopping !== tab.id) {
      setStopping(tab.id);
      setStatus(t("mission.stopConfirmHint", { name: tabName(tab) }));
      return;
    }
    setStopping(null);
    void act(() => api.orchestrationTabStop(tab.id), t("mission.stopped", { name: tabName(tab) }));
  }
  function saveSettings(): void {
    const n = Number.parseInt(minutes, 10);
    void act(async () => {
      const s = await api.orchestrationMissionSettingsPut({ stuckMinutes: Number.isFinite(n) ? n : stuckMinutes, nudgePrompt: nudgeText });
      setMinutes(String(s.stuckMinutes));
      setNudgeText(s.nudgePrompt);
    }, t("mission.settings.saved"));
  }

  function row(tab: MissionTab): JSX.Element {
    const reason = stuckReason(tab, now, stuckMinutes);
    const out = links.filter((l) => l.from === tab.id);
    const into = links.filter((l) => l.to === tab.id);
    const others = tabs.filter((x) => x.id !== tab.id && !x.exited);
    const free = others.filter((x) => !out.some((l) => l.to === x.id));
    const title = tabName(tab);
    return (
      <li key={tab.id} className="mc-row" data-stuck={reason ? "true" : undefined} aria-label={title}>
        <div className="mc-row-head">
          <StatusDot state={dotState(tab)} pulse={tab.status === "working"} label={title} />
          {reason ? <Tag tone="warn">{t(`mission.stuck.${reason}`)}</Tag> : null}
        </div>
        <p className="mc-meta">
          <span>{tab.lastOutputMs > 0 ? t("mission.lastOutput", { ago: ago(tab.lastOutputMs, now, t) }) : t("mission.noOutput")}</span>
          <span>{tab.worker ? t("mission.task", { task: tab.worker.taskTitle ?? tab.worker.taskId }) : t("mission.noTask")}</span>
          {tab.lastNudgeMs !== null ? <span>{t("mission.lastNudge", { ago: ago(tab.lastNudgeMs, now, t) })}</span> : null}
          {into.length > 0 ? <span>{t("mission.readBy", { names: into.map((l) => name(l.from)).join(", ") })}</span> : null}
        </p>
        {out.length > 0 ? (
          <ul className="mc-links" aria-label={t("mission.linksOf", { name: title })}>
            {out.map((l) => (
              <li key={l.to} className="mc-link">
                <span className="mc-link-name">{t("mission.reads", { name: name(l.to) })}</span>
                <Switch
                  label={t("mission.grant.transcript")}
                  checked={l.transcript}
                  aria-label={t("mission.grantLabel", { grant: t("mission.grant.transcript"), name: name(l.to) })}
                  onChange={(e) => void grant(l, "transcript", e.target.checked)}
                />
                <Switch
                  label={t("mission.grant.screen")}
                  checked={l.screen}
                  aria-label={t("mission.grantLabel", { grant: t("mission.grant.screen"), name: name(l.to) })}
                  onChange={(e) => void grant(l, "screen", e.target.checked)}
                />
                <Select
                  aria-label={t("mission.relink", { name: name(l.to) })}
                  value={l.to}
                  options={[{ value: l.to, label: name(l.to) }, ...free.map((x) => ({ value: x.id, label: tabName(x) }))]}
                  onChange={(e) => void relink(l, e.target.value)}
                />
                <Button variant="secondary" type="button" aria-label={t("mission.unlinkLabel", { name: name(l.to) })} onClick={() => void unlink(l)}>
                  {t("mission.unlink")}
                </Button>
                {l.screen ? (
                  <p className="mc-warn" role="note">
                    {t("mission.screenWarning")}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mc-actions">
          {free.length > 0 ? (
            <Select
              aria-label={t("mission.linkTo", { name: title })}
              value=""
              options={[{ value: "", label: t("mission.linkPlaceholder") }, ...free.map((x) => ({ value: x.id, label: tabName(x) }))]}
              onChange={(e) => {
                if (e.target.value) void linkTo(tab.id, e.target.value);
              }}
            />
          ) : null}
          <Button variant="secondary" type="button" onClick={() => onFocusTab(tab.id)}>
            {t("mission.focus")}
          </Button>
          {tab.agent && !tab.exited ? (
            <>
              <Button variant="secondary" type="button" aria-label={t("mission.nudgeLabel", { name: title })} onClick={() => void nudge(tab)}>
                {t("mission.nudge")}
              </Button>
              <Button variant="secondary" type="button" aria-label={t("mission.handoffLabel", { name: title })} onClick={() => onHandoff(tab.id)}>
                {t("mission.handoff")}
              </Button>
            </>
          ) : null}
          {tab.worker ? (
            <Button variant="secondary" type="button" aria-label={t(stopping === tab.id ? "mission.stopConfirmLabel" : "mission.stopLabel", { name: title })} onClick={() => stop(tab)}>
              {t(stopping === tab.id ? "mission.stopConfirm" : "mission.stop")}
            </Button>
          ) : null}
        </div>
      </li>
    );
  }

  return (
    <Dialog modal size="wide" title={t("mission.title")} confirmLabel={t("mission.close")} cancelLabel={null} onConfirm={onClose} onCancel={onClose} body="plain">
      <div className="mc-body">
        <p className="mc-status" role="status">
          {status}
        </p>
        <Tabs
          idPrefix="mc"
          label={t("mission.title")}
          value={view}
          onChange={(v) => onView(v === "map" ? "map" : "tabs")}
          items={[
            { id: "tabs", label: t("mission.view.tabs"), badge: stuckCount > 0 ? stuckCount : undefined },
            { id: "map", label: t("mission.view.map") },
          ]}
        />
        <div role="tabpanel" id={`mc-panel-${view}`} aria-labelledby={`mc-tab-${view}`} className="mc-panel">
          {failed && data === null ? (
            <p className="mc-empty">{t("mission.loadFailed")}</p>
          ) : data === null ? (
            <p className="mc-empty">{t("mission.loading")}</p>
          ) : view === "map" ? (
            <TeamMap tabs={rows.map((r) => ({ id: r.id, label: tabName(r) }))} links={links} onFocusTab={onFocusTab} />
          ) : rows.length === 0 ? (
            <p className="mc-empty">{t("mission.empty")}</p>
          ) : (
            <ul className="mc-list" aria-label={t("mission.view.tabs")}>
              {rows.map(row)}
            </ul>
          )}
        </div>
        <Disclosure title={t("mission.settings.title")} className="mc-settings" defaultExpanded={false}>
          <div className="mc-settings-body">
            <Field
              label={t("mission.settings.minutes")}
              hint={t("mission.settings.minutesHint")}
              type="number"
              min={1}
              max={1440}
              inputMode="numeric"
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
            />
            <Textarea label={t("mission.settings.nudge")} hint={t("mission.settings.nudgeHint")} rows={2} value={nudgeText} onChange={(e) => setNudgeText(e.target.value)} />
            <div>
              <Button variant="secondary" type="button" onClick={saveSettings}>
                {t("mission.settings.save")}
              </Button>
            </div>
          </div>
        </Disclosure>
      </div>
    </Dialog>
  );
}
