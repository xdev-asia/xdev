import { useEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import type { Api } from "../api";
import { useI18n } from "../i18n";
import { MemoryTab } from "../kit/MemoryTab";
import { PromptsTab } from "../kit/PromptsTab";
import { SkillsTab } from "../kit/SkillsTab";
import { UsageTab } from "../kit/UsageTab";

export type KitTab = "skills" | "memory" | "prompts" | "usage";

const TABS: readonly KitTab[] = ["skills", "memory", "prompts", "usage"];

/** A request to show a tab; a new `seq` is a new request. */
export interface KitRequest {
  tab: KitTab;
  seq: number;
}

/** What the shell gives the Agent kit: the worktree it looks at, a request to open a tab, and the agent tab to type into. */
export interface KitHost {
  worktree: string | null;
  /** The request still waiting to be shown; `null` once the Kit has taken it, so a later mount opens nothing. */
  open: KitRequest | null;
  /** Called with the `seq` of a request the Kit has shown. */
  onOpened?: (seq: number) => void;
  onSendToAgent?: (text: string) => Promise<boolean>;
  /** Whether an agent tab is in front to type into. */
  canSend?: boolean;
}

/** Skills, memory, prompts and token usage of the agents installed here. */
export function AgentKitView(props: {
  api: Api;
  worktree: string | null;
  initialTab?: KitTab;
  /** A request to switch tabs; the same view takes each new one, so nothing the person typed is lost. */
  request?: KitRequest | null;
  onRequestHandled?: (seq: number) => void;
  onSendToAgent?: (text: string) => Promise<boolean>;
  canSend?: boolean;
  onOpenContext?: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const { api, worktree } = props;
  const first = props.request?.tab ?? props.initialTab ?? "skills";
  const [tab, setTab] = useState<KitTab>(first);
  // A tab that was shown stays mounted, so an open file or a typed prompt survives a switch.
  const [seen, setSeen] = useState<ReadonlySet<KitTab>>(() => new Set([first]));
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);

  function show(next: KitTab): void {
    setTab(next);
    setSeen((s) => (s.has(next) ? s : new Set([...s, next])));
  }

  // Each new request shows its tab on this same view, then is handed back so it is not shown again.
  const requestSeq = props.request?.seq;
  useEffect(() => {
    const request = props.request;
    if (!request) return;
    show(request.tab);
    props.onRequestHandled?.(request.seq);
    // `show` only sets state; the request itself decides when this runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestSeq]);

  function onKey(e: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const jump = e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : undefined;
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (step === 0 && jump === undefined) return;
    e.preventDefault();
    const next = jump ?? (index + step + TABS.length) % TABS.length;
    show(TABS[next]!);
    tabs.current[next]?.focus();
  }

  return (
    <section className="kit" aria-label={t("apps.kit")}>
      <div className="kit-tabs" role="tablist" aria-label={t("kit.tabs")}>
        {TABS.map((id, i) => (
          <button
            key={id}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`kit-tab-${id}`}
            data-tab={id}
            aria-selected={tab === id}
            aria-controls={`kit-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            className="kit-tab"
            onClick={() => show(id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {t(`kit.tab.${id}`)}
          </button>
        ))}
      </div>
      {TABS.map((id) => (
        <div
          key={id}
          className="kit-panel-host"
          role="tabpanel"
          id={`kit-panel-${id}`}
          aria-labelledby={`kit-tab-${id}`}
          hidden={tab !== id}
        >
          {seen.has(id) && id === "skills" && <SkillsTab api={api} worktree={worktree} />}
          {seen.has(id) && id === "memory" && <MemoryTab api={api} worktree={worktree} onOpenContext={props.onOpenContext} />}
          {seen.has(id) && id === "prompts" && <PromptsTab api={api} worktree={worktree} onSendToAgent={props.onSendToAgent} canSend={props.canSend} />}
          {seen.has(id) && id === "usage" && <UsageTab api={api} />}
        </div>
      ))}
    </section>
  );
}
