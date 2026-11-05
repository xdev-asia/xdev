import { IconButton, Popover, Tooltip } from "@xdev-asia/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import type { Api, ContextUsage } from "@/api";
import { useI18n } from "@/i18n";
import type { Tab } from "@/workspace/sessions";
import { CONTEXT_WARN, contextPercent, formatElapsed, formatTokens, runElapsed, tabAccount, tabQuota, type RunClock, type TabQuota } from "./chipModel";
import { useChipPrefs, type ChipPrefs } from "./chipPrefs";
import { useChipQuota } from "./quotaStore";
import { useRunClocks } from "./runClocks";
import { useContextUsage } from "./useContextUsage";

/** The run timer: it alone re-renders every second, and only while the agent works. */
function TimerChip({ clock, label }: { clock: RunClock; label: (running: boolean, time: string) => string }): JSX.Element {
  const running = clock.endedAt === null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  const time = formatElapsed(runElapsed(clock, now));
  const text = label(running, time);
  return (
    <Chip kind="timer" tip={text} aria={text} running={running}>
      <span aria-hidden="true">{time}</span>
    </Chip>
  );
}

function Chip(props: { kind: string; tip: string; aria: string; warn?: boolean; running?: boolean; children: ReactNode }): JSX.Element {
  return (
    <Tooltip content={props.tip} placement="bottom">
      <span
        className="pane-chip"
        role="group"
        tabIndex={0}
        aria-label={props.aria}
        data-chip={props.kind}
        data-warn={props.warn ? "" : undefined}
        data-running={props.running ? "" : undefined}
      >
        {props.children}
      </span>
    </Tooltip>
  );
}

/** What the header shows for the front tab, already resolved; hooks live in `PaneChips`. */
export interface PaneChipsViewProps {
  agent: boolean;
  prefs: ChipPrefs;
  /** Null hides the quota chip (no account, no windows, or not read yet). */
  quota: TabQuota | null;
  /** Null hides the context chip: unknown is never drawn as zero. */
  usage: ContextUsage | null;
  clock: RunClock | undefined;
  narrow: boolean;
  hasNote: boolean;
  onNote: () => void;
  open: boolean;
  onOpen: (open: boolean) => void;
  /** The polite announcement for the status region. */
  said: string;
}

/**
 * The chips of the pane header: quota of the tab's account, context window use and the run timer, each turned
 * on or off from the terminal menu. Narrow, they move into a popover behind one button. The sticky note
 * button is always in the header.
 */
export function PaneChipsView(props: PaneChipsViewProps): JSX.Element {
  const { prefs, narrow, usage } = props;
  const { t } = useI18n();
  const chips: JSX.Element[] = [];
  const q = prefs.quota ? props.quota : null;
  if (q) {
    const short = [q.fiveHour !== null && t("paneChips.quota.short.five", { pct: q.fiveHour }), q.weekly !== null && t("paneChips.quota.short.week", { pct: q.weekly })].filter(Boolean).join(" · ");
    const parts = [q.fiveHour !== null && t("paneChips.quota.five", { pct: q.fiveHour }), q.weekly !== null && t("paneChips.quota.week", { pct: q.weekly })].filter(Boolean).join(", ");
    const text = t("paneChips.quota.tip", { account: q.account, parts });
    chips.push(
      <Chip key="quota" kind="quota" tip={text} aria={text} warn={Math.max(q.fiveHour ?? 0, q.weekly ?? 0) >= CONTEXT_WARN}>
        <span aria-hidden="true">{short}</span>
      </Chip>,
    );
  }
  const pct = usage && prefs.context ? contextPercent(usage.tokens, usage.window) : null;
  if (usage && pct !== null) {
    const text = t("paneChips.context.tip", { used: usage.tokens.toLocaleString("en-US"), window: usage.window.toLocaleString("en-US"), pct });
    chips.push(
      <Chip key="context" kind="context" tip={text} aria={text} warn={pct >= CONTEXT_WARN}>
        <span aria-hidden="true">{t("paneChips.context.short", { pct })}</span>
        <span className="pane-chip-sub" aria-hidden="true">
          {formatTokens(usage.tokens)}
        </span>
      </Chip>,
    );
  }
  if (props.agent && prefs.timer && props.clock) {
    chips.push(<TimerChip key="timer" clock={props.clock} label={(running, time) => t(running ? "paneChips.timer.running" : "paneChips.timer.stopped", { time })} />);
  }

  return (
    <div className="pane-chips" data-narrow={narrow ? "" : undefined}>
      {narrow ? (
        chips.length > 0 && (
          <Popover
            open={props.open}
            onClose={() => props.onOpen(false)}
            placement="bottom-end"
            label={t("paneChips.overflow.panel")}
            className="pane-chips-panel"
            trigger={(p) => <IconButton {...p} icon="more" label={t("paneChips.overflow")} onClick={() => props.onOpen(!props.open)} />}
          >
            <div className="pane-chips-list">{chips}</div>
          </Popover>
        )
      ) : (
        chips
      )}
      <span className="pane-note-btn">
        <IconButton icon="edit" label={t(props.hasNote ? "notes.button.filled" : "notes.button")} onClick={props.onNote} data-testid="note-button" />
        {props.hasNote && <span className="pane-note-dot" aria-hidden="true" />}
      </span>
      <span className="x-sr-only" role="status">
        {props.said}
      </span>
    </div>
  );
}

/** The chips for the front terminal tab of a pane header, fed by the quota, the agent log and the run clocks. */
export function PaneChips(props: { api: Api; tab: Tab; narrow: boolean; hasNote: boolean; onNote: () => void }): JSX.Element {
  const { api, tab } = props;
  const { t } = useI18n();
  const prefs = useChipPrefs();
  const [open, setOpen] = useState(false);
  const provider = tab.agent && tab.cli ? tab.cli : null;
  const { quota, accounts } = useChipQuota(api, provider !== null && prefs.quota);
  const usage = useContextUsage(api, tab.agentSession, tab.status, provider !== null && prefs.context);
  const clock = useRunClocks().get(tab.id);

  // The end of a run is said once, politely; the ticking time is not live.
  const [said, setSaid] = useState("");
  const ended = useRef<number | null>(null);
  useEffect(() => {
    if (!clock || clock.endedAt === null || ended.current === clock.endedAt) return;
    ended.current = clock.endedAt;
    if (prefs.timer) setSaid(t("paneChips.timer.done", { time: formatElapsed(runElapsed(clock, clock.endedAt)) }));
  }, [clock, prefs.timer, t]);
  useEffect(() => setSaid(""), [tab.id]);

  return (
    <PaneChipsView
      agent={tab.agent}
      prefs={prefs}
      quota={provider ? tabQuota(quota, tabAccount(tab, accounts)) : null}
      usage={usage}
      clock={clock}
      narrow={props.narrow}
      hasNote={props.hasNote}
      onNote={props.onNote}
      open={open}
      onOpen={setOpen}
      said={said}
    />
  );
}
