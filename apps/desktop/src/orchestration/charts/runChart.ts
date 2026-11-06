import { toApiError, type Api, type Chart, type ChartRun, type ChartSeat, type LaunchOverrides, type SeatTab } from "@/api";

/** What a run needs from the workspace: where the tabs go and how one is opened. */
export interface ChartRunHost {
  /** The worktree in front; null when there is none. */
  worktree(): string | null;
  /** Opens one agent tab, as an orchestration worker tab is opened: given id and title, the prompt on first launch. */
  open(worktree: string, seat: ChartSeat, opts: { id: string; title: string; background: boolean; prompt?: string; overrides?: LaunchOverrides }): void;
  /** Holds `launch` until the worktree's setup lets agents start; false when nothing waits. */
  defer?(worktree: string, launch: () => void): boolean;
  /** A fresh tab id. */
  newId(): string;
}

export type ChartRunOutcome =
  | { kind: "ok"; run: ChartRun; tabs: SeatTab[] }
  | { kind: "no_worktree" }
  | { kind: "agent_unusable"; agent: string }
  | { kind: "failed"; detail: string };

/** A seat's launch options: its model, when it has one. */
export function overridesOf(seat: Pick<ChartSeat, "model">): LaunchOverrides | undefined {
  const model = seat.model?.trim();
  return model ? { model, effort: null, extraArgs: [] } : undefined;
}

/**
 * Starts every seat of `chart` as an agent tab in the worktree in front, then records the tabs as a run so the links
 * and the hierarchy rule hold. Every seat's agent must be on and installed first; none opens otherwise.
 */
export async function runChart(api: Pick<Api, "profiles" | "chartsRunBind">, host: ChartRunHost, chart: Chart, title: (seat: ChartSeat, index: number) => string): Promise<ChartRunOutcome> {
  const worktree = host.worktree();
  if (!worktree) return { kind: "no_worktree" };
  try {
    const view = await api.profiles();
    const usable = (id: string) => view.profiles.some((p) => p.profile.id === id && p.profile.enabled && p.installed);
    const bad = chart.seats.find((s) => !usable(s.agent));
    if (bad) return { kind: "agent_unusable", agent: bad.agent };
  } catch (e) {
    return { kind: "failed", detail: toApiError(e).detail ?? "" };
  }
  const tabs: SeatTab[] = chart.seats.map((s) => ({ seat: s.id, tab: host.newId() }));
  const opened = new Promise<string | null>((resolve) => {
    const launch = (): void => {
      try {
        chart.seats.forEach((seat, i) => {
          const prompt = seat.prompt.trim();
          host.open(worktree, seat, { id: tabs[i].tab, title: title(seat, i), background: i > 0, prompt: prompt || undefined, overrides: overridesOf(seat) });
        });
        resolve(null);
      } catch (e) {
        resolve(e instanceof Error ? e.message : String(e));
      }
    };
    if (!host.defer?.(worktree, launch)) launch();
  });
  const failed = await opened;
  if (failed !== null) return { kind: "failed", detail: failed };
  try {
    const run = await api.chartsRunBind(chart.id, tabs);
    return { kind: "ok", run, tabs };
  } catch (e) {
    return { kind: "failed", detail: toApiError(e).detail ?? "" };
  }
}
