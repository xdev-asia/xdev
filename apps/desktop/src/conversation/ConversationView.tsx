import { Button, EmptyState, IconButton, Segmented, Spinner, Switch, Tag } from "@xdev-asia/ui";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import type { Api, ConversationEntry } from "@/api";
import { openFile } from "@/files/openFile";
import { useI18n } from "@/i18n";
import { copyText } from "@/ui/clipboard";
import { ContextMenu, type MenuItem } from "@/ui/ContextMenu";
import type { TabStatus } from "@/workspace/status";
import { Markdown, MarkdownContext, pathCandidates, type MarkdownEnv } from "./Markdown";
import { atBottom, failedSteps, foldRows, hasOlder, mergePage, olderPage, readPrefs, stepSize, TEXT_SIZES, writePrefs, type ConversationPrefs, type Loaded, type Row } from "./model";
import "./conversation.css";

/** The most paths one resolve call takes, as `links_open.rs`. */
const RESOLVE_BATCH = 64;
/** Scrolled this close to the top, the list loads the page before. */
const TOP_PX = 48;

export interface ConversationTab {
  id: string;
  agentSession: string | null;
  status: TabStatus;
  worktree: string;
}

export interface ConversationViewProps {
  api: Pick<Api, "agentConversation" | "fileLinksResolve" | "openUrl">;
  tab: ConversationTab;
  /** The agent's name, as the tab shows it. */
  agentName: string;
  /** `split` sits beside the terminal; `full` covers it and has a back button. */
  mode: "split" | "full";
  onBack: () => void;
  /** A new value asks the view to take keyboard focus. */
  focusSeq?: number;
}

type Load = { state: "loading" } | { state: "error" } | { state: "ready"; data: Loaded };

function time(at: number): string {
  return at > 0 ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
}

/** The chat-style and reader views of one agent tab's conversation. */
export function ConversationView(props: ConversationViewProps): JSX.Element {
  const { api, tab, mode, onBack } = props;
  const { t } = useI18n();
  const session = tab.agentSession;
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [prefs, setPrefsState] = useState<ConversationPrefs>(readPrefs);
  const [showTools, setShowTools] = useState(false);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [said, setSaid] = useState("");
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; url: string } | null>(null);
  const [resolved, setResolved] = useState<Map<string, string | null>>(() => new Map());
  const [older, setOlder] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  // The link a menu opened from, focused again when the menu closes.
  const menuFrom = useRef<HTMLElement | null>(null);
  const stick = useRef(true);
  // Set before older items are added: the height to keep the view still against.
  const anchor = useRef<number | null>(null);

  const setPrefs = (next: ConversationPrefs) => {
    setPrefsState(next);
    writePrefs(next);
  };

  // The last page, merged into what is loaded; the first read of a session starts afresh.
  const refresh = useCallback(
    async (fresh: boolean) => {
      if (!session) return;
      try {
        const page = await api.agentConversation(session);
        setLoad((prev) => ({ state: "ready", data: mergePage(fresh || prev.state !== "ready" ? null : prev.data, page) }));
        return true;
      } catch {
        setLoad((prev) => (prev.state === "ready" && !fresh ? prev : { state: "error" }));
        return false;
      }
    },
    [api, session],
  );

  useEffect(() => {
    setLoad({ state: "loading" });
    stick.current = true;
    void refresh(true);
  }, [refresh]);

  // The tab settling (a turn ended) means new lines in the log.
  const settled = tab.status !== "working";
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (settled) void refresh(false).then((ok) => ok && setSaid(t("conversation.updated")));
  }, [settled, tab.status]);

  const data = load.state === "ready" ? load.data : null;

  async function loadOlder(): Promise<void> {
    if (!data || !session || older || !hasOlder(data)) return;
    setOlder(true);
    const { from, limit } = olderPage(data);
    try {
      const page = await api.agentConversation(session, from, limit);
      anchor.current = list.current ? list.current.scrollHeight - list.current.scrollTop : null;
      setLoad((prev) => (prev.state === "ready" ? { state: "ready", data: mergePage(prev.data, page) } : prev));
      setSaid(t("conversation.older.said", { count: page.items.length }));
    } catch {
      setSaid(t("conversation.error"));
    } finally {
      setOlder(false);
    }
  }

  // Older items keep the view where it was; new ones follow the end unless the person scrolled up.
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    if (anchor.current !== null) {
      el.scrollTop = el.scrollHeight - anchor.current;
      anchor.current = null;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [data, prefs.mode, showTools]);

  const onScroll = () => {
    const el = list.current;
    if (!el) return;
    stick.current = atBottom(el);
    if (el.scrollTop < TOP_PX) void loadOlder();
  };

  // The paths of the loaded text, resolved against the worktree in batches; unknown ones only.
  const texts = useMemo(() => (data ? data.items.filter((i) => i.kind === "user" || i.kind === "assistant").map((i) => i.text) : []), [data]);
  useEffect(() => {
    const wanted = [...new Set(texts.flatMap(pathCandidates))].filter((p) => !resolved.has(p));
    if (wanted.length === 0) return;
    let live = true;
    void (async () => {
      const found = new Map<string, string | null>();
      for (let i = 0; i < wanted.length; i += RESOLVE_BATCH) {
        const batch = wanted.slice(i, i + RESOLVE_BATCH);
        const rels = await api.fileLinksResolve(tab.worktree, batch).catch(() => batch.map(() => null));
        batch.forEach((p, j) => found.set(p, rels[j] ?? null));
      }
      if (live) setResolved((prev) => new Map([...prev, ...found]));
    })();
    return () => {
      live = false;
    };
  }, [texts, api, tab.worktree]);

  const copy = useCallback(
    async (text: string, done: string) => setSaid((await copyText(text)) ? done : t("conversation.copyFailed")),
    [t],
  );

  const env = useMemo<MarkdownEnv>(
    () => ({
      resolved: (p) => resolved.get(p),
      onPath: ({ path, rel, line, column }) => {
        if (rel) openFile({ worktree: tab.worktree, rel, ...(line !== undefined ? { line } : {}), ...(column !== undefined ? { column } : {}) });
        else void copy(path, t("conversation.path.copied"));
      },
      onLink: (url, at, from) => {
        menuFrom.current = from;
        setMenu({ url, at });
      },
      label: {
        open: (p) => t("conversation.path.open", { path: p }),
        copy: (p) => t("conversation.path.copy", { path: p }),
        code: { copy: t("conversation.code.copy"), copied: t("conversation.code.copied") },
      },
    }),
    [resolved, tab.worktree, copy, t],
  );

  const closeMenu = () => {
    setMenu(null);
    const from = menuFrom.current;
    setTimeout(() => from?.isConnected && from.focus(), 0);
  };

  const menuItems: MenuItem[] = menu
    ? [
        { id: "open", labelKey: "conversation.link.open", run: () => void api.openUrl(menu.url).catch(() => setSaid(t("conversation.error"))) },
        { id: "copy", labelKey: "conversation.link.copy", run: () => void copy(menu.url, t("conversation.link.copied")) },
      ]
    : [];

  // Focus moves in on open and on each new request.
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const id = setTimeout(() => (list.current ?? root.current)?.focus({ preventScroll: true }), 0);
    return () => clearTimeout(id);
  }, [props.focusSeq]);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape" || menu || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    onBack();
  };

  const sizeIndex = TEXT_SIZES.indexOf(prefs.size);
  const resize = (by: -1 | 1) => {
    const size = stepSize(prefs.size, by);
    setPrefs({ ...prefs, size });
    setSaid(t("conversation.size.said", { size: t(`conversation.size.${size}`) }));
  };

  const rows = useMemo(() => (data ? foldRows(data.items) : []), [data]);

  return (
    <section ref={root} className="cv" tabIndex={-1} data-mode={mode} data-view={prefs.mode} data-size={prefs.size} aria-label={t("conversation.region", { name: props.agentName })} onKeyDown={onKeyDown}>
      <header className="cv-head">
        <IconButton icon={mode === "full" ? "arrow-left" : "close"} label={t(mode === "full" ? "conversation.back" : "conversation.close")} onClick={onBack} data-testid="conversation-back" />
        <h2 className="cv-title">{t("conversation.title")}</h2>
        <div className="cv-tools-bar">
          <Segmented
            label={t("conversation.mode")}
            value={prefs.mode}
            onChange={(v) => setPrefs({ ...prefs, mode: v === "reader" ? "reader" : "chat" })}
            options={[
              { value: "chat", label: t("conversation.mode.chat") },
              { value: "reader", label: t("conversation.mode.reader") },
            ]}
          />
          <IconButton icon="minus" label={t("conversation.size.smaller")} disabled={sizeIndex <= 0} onClick={() => resize(-1)} />
          <IconButton icon="plus" label={t("conversation.size.larger")} disabled={sizeIndex >= TEXT_SIZES.length - 1} onClick={() => resize(1)} />
        </div>
      </header>
      {data && <SessionStrip data={data} agentName={props.agentName} />}
      {prefs.mode === "reader" && data && rows.some((r) => r.kind === "tools") && (
        <div className="cv-reader-bar">
          <Switch label={t("conversation.reader.tools")} checked={showTools} onChange={(e) => setShowTools(e.currentTarget.checked)} />
        </div>
      )}
      <MarkdownContext.Provider value={env}>
        <div ref={list} className="cv-list" tabIndex={0} role="region" aria-label={t("conversation.title")} aria-busy={load.state === "loading" || older} onScroll={onScroll}>
          {load.state === "loading" && (
            <div className="cv-center">
              <Spinner label={t("conversation.loading")} />
            </div>
          )}
          {load.state === "error" && (
            <EmptyState
              title={t("conversation.error")}
              actions={
                <Button type="button" variant="secondary" onClick={() => void refresh(true)}>
                  {t("conversation.retry")}
                </Button>
              }
            />
          )}
          {data && data.items.length === 0 && <EmptyState title={t("conversation.empty")} hint={t("conversation.empty.hint")} />}
          {data && hasOlder(data) && (
            <div className="cv-older">
              <Button type="button" variant="secondary" disabled={older} onClick={() => void loadOlder()}>
                {t("conversation.older")}
              </Button>
            </div>
          )}
          {data && <ConversationContent rows={rows} view={prefs.mode} agentName={props.agentName} open={open} onToggle={(key) => setOpen((s) => toggled(s, key))} showTools={showTools} />}
        </div>
      </MarkdownContext.Provider>
      <span className="x-sr-only" role="status">
        {said}
      </span>
      {menu && <ContextMenu at={menu.at} title={menu.url} label={t("conversation.link.menu", { url: menu.url })} items={menuItems} onClose={closeMenu} />}
    </section>
  );
}

/** The loaded rows as a chat list or as one reader document. */
export function ConversationContent(props: { rows: Row[]; view: ConversationPrefs["mode"]; agentName: string; open: ReadonlySet<string>; onToggle: (key: string) => void; showTools: boolean }): JSX.Element {
  const { rows } = props;
  if (props.view === "reader") {
    return (
      <article className="cv-doc">
        {rows.map((row) => (
          <ReaderRow key={row.key} row={row} showTools={props.showTools} />
        ))}
      </article>
    );
  }
  return (
    <ol className="cv-chat">
      {rows.map((row) => (
        <ChatRow key={row.key} row={row} agentName={props.agentName} open={props.open.has(row.key)} onToggle={() => props.onToggle(row.key)} />
      ))}
    </ol>
  );
}

function toggled(s: Set<string>, key: string): Set<string> {
  const next = new Set(s);
  if (!next.delete(key)) next.add(key);
  return next;
}

function markerText(item: ConversationEntry, t: (k: string, v?: Record<string, string | number>) => string): string {
  switch (item.marker) {
    case "compact":
      return t("conversation.marker.compact");
    case "resume":
      return t("conversation.marker.resume");
    case "model":
      return t("conversation.marker.model", { model: item.text });
    default:
      return item.text;
  }
}

export function SessionStrip({ data, agentName }: { data: Loaded; agentName: string }): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="cv-strip" role="group" aria-label={t("conversation.strip")}>
      <span className="cv-strip-agent">{agentName}</span>
      {data.model && <Tag>{data.model}</Tag>}
      <span className="cv-strip-turns">{t("conversation.strip.turns", { count: data.turns })}</span>
      {data.markers.map((m) => (
        <span key={m.index} className="cv-strip-marker" data-marker={m.marker ?? undefined} title={time(m.at)}>
          {markerText(m, t)}
        </span>
      ))}
    </div>
  );
}

function ToolSteps({ items }: { items: ConversationEntry[] }): JSX.Element {
  const { t } = useI18n();
  return (
    <ol className="cv-steps">
      {items.map((item) => {
        const step = item.tool;
        if (!step) return null;
        return (
          <li key={item.index} className="cv-step" data-status={step.status}>
            <div className="cv-step-head">
              <span className="cv-step-dot" data-status={step.status} aria-hidden="true" />
              <span className="cv-step-name">{step.name}</span>
              <span className="cv-step-summary">{step.summary}</span>
              <span className="cv-step-status">{t(`conversation.tool.${step.status === "error" ? "error" : step.status === "ok" ? "ok" : "pending"}`)}</span>
            </div>
            {step.output && <pre className="cv-step-out">{step.output}</pre>}
            {step.cut && <p className="cv-step-cut">{t("conversation.tool.cut")}</p>}
          </li>
        );
      })}
    </ol>
  );
}

function ToolsLabel({ items }: { items: ConversationEntry[] }): JSX.Element {
  const { t } = useI18n();
  const failed = failedSteps(items);
  return (
    <>
      <span>{t("conversation.tools", { count: items.length })}</span>
      {failed > 0 && <span className="cv-tools-failed">{t("conversation.tools.failed", { count: failed })}</span>}
    </>
  );
}

function ChatRow({ row, agentName, open, onToggle }: { row: Row; agentName: string; open: boolean; onToggle: () => void }): JSX.Element {
  const { t } = useI18n();
  if (row.kind === "tools") {
    return (
      <li className="cv-row cv-row-tools">
        <button type="button" className="cv-tools" aria-expanded={open} onClick={onToggle}>
          <span className="cv-chevron" aria-hidden="true" />
          <ToolsLabel items={row.items} />
        </button>
        {open && <ToolSteps items={row.items} />}
      </li>
    );
  }
  if (row.kind === "marker") {
    return (
      <li className="cv-row cv-marker" data-marker={row.item.marker ?? undefined}>
        <span>{markerText(row.item, t)}</span>
      </li>
    );
  }
  const who = row.kind === "user" ? t("conversation.you") : agentName;
  return (
    <li className="cv-row cv-msg" data-role={row.kind}>
      <div className="cv-bubble">
        <span className="x-sr-only">{who}: </span>
        <Markdown text={row.item.text} />
      </div>
      {row.item.at > 0 && (
        <time className="cv-time" dateTime={new Date(row.item.at).toISOString()}>
          {time(row.item.at)}
        </time>
      )}
    </li>
  );
}

function ReaderRow({ row, showTools }: { row: Row; showTools: boolean }): JSX.Element | null {
  const { t } = useI18n();
  switch (row.kind) {
    case "user":
      return <h3 className="cv-doc-turn">{row.item.text}</h3>;
    case "assistant":
      return (
        <div className="cv-doc-body">
          <Markdown text={row.item.text} />
        </div>
      );
    case "tools":
      return showTools ? (
        <div className="cv-doc-tools">
          <p className="cv-doc-tools-label">
            <ToolsLabel items={row.items} />
          </p>
          <ToolSteps items={row.items} />
        </div>
      ) : null;
    case "marker":
      return (
        <p className="cv-marker cv-doc-marker" data-marker={row.item.marker ?? undefined}>
          {markerText(row.item, t)}
        </p>
      );
  }
}
