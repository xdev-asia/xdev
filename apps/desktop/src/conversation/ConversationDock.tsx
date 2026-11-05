import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { Api } from "@/api";
import { terminalOf } from "@/terminal/terminalRegistry";
import { canShowConversation, closeConversation, useConversationOpen } from "./conversationStore";
import { ConversationView, type ConversationTab } from "./ConversationView";
import { feedQuestions } from "./questionStore";
import { SPLIT_MIN_PX } from "./model";

/**
 * The conversation of one terminal tab, placed in the tab's pane: beside the terminal when the pane is at least
 * 900px wide, over it (with a back button) when narrower. Closing gives the keyboard back to the terminal.
 */
export function ConversationDock(props: {
  api: Pick<Api, "agentConversation" | "fileLinksResolve" | "openUrl"> & Partial<Pick<Api, "ptyWrite" | "composerDraftPut" | "onPtyHook">>;
  tab: ConversationTab & { agent: boolean };
  agentName: string;
}): JSX.Element | null {
  const { tab } = props;
  const seq = useConversationOpen(tab.id);
  const shown = seq > 0 && canShowConversation(tab);
  const ref = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(true);

  // Questions are read from the hooks whether or not the view is open: the tab's badge shows them.
  const { api } = props;
  useEffect(() => {
    if (api.onPtyHook) feedQuestions(api as Pick<Api, "onPtyHook">);
  }, [api]);

  // The pane's width picks the layout; it changes with splits and the window.
  useLayoutEffect(() => {
    const pane = ref.current?.parentElement;
    if (!shown || !pane) return;
    const measure = () => setWide(pane.getBoundingClientRect().width >= SPLIT_MIN_PX);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(pane);
    return () => ro.disconnect();
  }, [shown]);

  // Covered, the terminal leaves the tab order and the reading order.
  const mode = wide ? "split" : "full";
  useLayoutEffect(() => {
    const term = ref.current?.parentElement?.querySelector(":scope > .terminal-pane");
    if (!shown || mode !== "full" || !term) return;
    term.setAttribute("inert", "");
    return () => term.removeAttribute("inert");
  }, [shown, mode]);

  if (!shown) return null;
  const back = () => {
    closeConversation(tab.id);
    setTimeout(() => terminalOf(tab.id)?.focus(), 0);
  };
  return (
    <div ref={ref} className="cv-dock" data-mode={mode} data-testid="conversation-dock">
      <ConversationView api={props.api} tab={tab} agentName={props.agentName} mode={mode} onBack={back} onOpenTerminal={back} focusSeq={seq} />
    </div>
  );
}
