import { Banner, Button, EmptyState, IconButton, Menu, TabStrip, Textarea } from "@xdev-asia/ui";
import type { MenuEntry, TabItem } from "@xdev-asia/ui";
import { useState } from "react";
import type { JSX } from "react";
import type { Api } from "@/api";
import { BrowserTab } from "@/browser/BrowserTab";
import { useBrowserTabs } from "@/browser/browserTabs";
import { MarkdownPane } from "@/files/MarkdownPane";
import { useI18n } from "@/i18n";
import { useKeymap } from "@/keys/keymap";
import { Terminal } from "@/terminal/Terminal";
import { loadNote, saveNote } from "./floatingNote";
import {
  FLOATING_WORKTREE,
  addFloatingTab,
  closeFloating,
  closeFloatingTab,
  floatingState,
  focusInFloating,
  selectFloatingTab,
  stepFloatingTab,
  useFloating,
} from "./floatingStore";
import type { FloatingKind } from "./floatingStore";
import "./floating.css";

const NOTE_REL = "scratch.md";

/**
 * The floating workspace: terminal, browser and note tabs that belong to no project. It stays mounted
 * once opened and closing only hides it, so the shells keep running (`Terminal` kills its pty on unmount).
 */
export function FloatingPanel(props: { api: Api; home: string | null; homeError: string | null }): JSX.Element {
  const { api, home, homeError } = props;
  const { t } = useI18n();
  const { open, tabs, active } = useFloating();
  const browsers = useBrowserTabs();
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState(() => loadNote());
  const [failed, setFailed] = useState<Record<string, string>>({});

  // While focus is in the panel the tab keys are the panel's; the project's tab keymap declines.
  useKeymap(
    {
      "tab.new": () => {
        addFloatingTab("terminal");
      },
      "tab.close": () => {
        const id = floatingState().active;
        if (id === null) return false;
        closeFloatingTab(id);
      },
      "tab.next": () => stepFloatingTab(1),
      "tab.prev": () => stepFloatingTab(-1),
    },
    { when: () => floatingState().open && focusInFloating() },
  );

  const name = (tab: { id: string; kind: FloatingKind; n: number }): string => {
    if (tab.kind === "terminal") return t("floating.tab.terminal", { n: tab.n });
    if (tab.kind === "note") return t("floating.tab.note");
    return browsers.find((b) => b.id === tab.id)?.title || t("floating.tab.browser");
  };
  const items: TabItem[] = tabs.map((tab) => ({ id: tab.id, name: name(tab) }));
  const kinds: FloatingKind[] = ["terminal", "browser", "note"];
  const menu: MenuEntry[] = kinds.map((kind) => ({ label: t(`floating.new.${kind}`), onSelect: () => void addFloatingTab(kind) }));

  const body = (tab: { id: string; kind: FloatingKind; n: number }): JSX.Element | null => {
    const front = tab.id === active;
    if (tab.kind === "terminal") {
      // Not drawn until the home folder is known: a terminal needs its folder to start.
      if (home === null) return null;
      return (
        <div key={tab.id} className="floating-ws-pane" hidden={!front}>
          {failed[tab.id] ? <Banner tone="danger" title={t("floating.terminalFailed", { message: failed[tab.id] })} /> : null}
          <Terminal
            api={api}
            id={tab.id}
            cwd={home}
            profile="shell"
            onStarted={() => {}}
            onError={(e) => setFailed((f) => ({ ...f, [tab.id]: e.detail ?? e.code }))}
          />
        </div>
      );
    }
    if (tab.kind === "browser") {
      const entry = browsers.find((b) => b.id === tab.id);
      if (!entry) return null;
      return (
        <div key={tab.id} className="floating-ws-pane" hidden={!front}>
          <BrowserTab api={api} entry={entry} visible={open && front} />
        </div>
      );
    }
    return (
      <div key={tab.id} className="floating-ws-pane" hidden={!front}>
        <MarkdownPane
          api={api}
          worktree={FLOATING_WORKTREE}
          rel={NOTE_REL}
          text={note}
          source={
            <Textarea
              label={t("floating.tab.note")}
              mono
              rows={12}
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
                saveNote(e.target.value);
              }}
            />
          }
        />
      </div>
    );
  };

  return (
    <section className="floating-ws" role="region" aria-label={t("floating.title")} hidden={!open}>
      <div className="floating-ws-head">
        <TabStrip
          tabs={items}
          selected={active ?? undefined}
          label={t("floating.title")}
          labels={{ newTab: t("floating.add"), close: (n) => t("floating.tab.close", { name: n }) }}
          onSelect={selectFloatingTab}
          onClose={closeFloatingTab}
          onAdd={() => setAdding(true)}
        />
        <IconButton icon="close" label={t("floating.close")} onClick={() => closeFloating()} />
        {adding ? (
          <div className="floating-ws-add">
            <Menu items={menu} label={t("floating.add")} onClose={() => setAdding(false)} />
          </div>
        ) : null}
      </div>
      <div className="floating-ws-body">
        {homeError ? <Banner tone="danger" title={t("floating.homeFailed", { message: homeError })} /> : null}
        {tabs.length === 0 ? (
          <div className="floating-ws-empty">
            <EmptyState
              title={t("floating.empty.title")}
              hint={t("floating.empty.body")}
              actions={
                <Button variant="primary" onClick={() => void addFloatingTab("terminal")}>
                  {t("floating.empty.cta")}
                </Button>
              }
            />
          </div>
        ) : (
          tabs.map(body)
        )}
      </div>
    </section>
  );
}
