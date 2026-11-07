import { Button, Checkbox, IconButton, ListRow, SplitHandle, StatusDot, Tag, Textarea, type StatusTone } from "@xdev-asia/ui";
import { useEffect, useId, useRef, useState } from "react";
import type { ChangeEvent, JSX, KeyboardEvent, SyntheticEvent } from "react";
import { toApiError, type Api, type PromptQueueItem, PromptQueueQuotaFact, PromptQueueWhenInput, PromptTemplate } from "@/api";
import { completionKey, tokenAtCursor, type Token } from "@/agentLaunch/completion";
import type { SkillItem } from "@/agentLaunch/PromptComposer";
import { useI18n } from "@/i18n";
import { applyMention, finalPrompt, mentionsFor, type Mention } from "./mentions";
import { QueuePanel } from "./QueuePanel";
import { ScheduleForm } from "./ScheduleForm";
import { TemplatesManager } from "./TemplatesManager";
import { useDraft } from "./useDraft";
import { retryTargets, type SendResult } from "./verify";

/** One open terminal tab the composer can send to. */
export type ComposerTab = { id: string; label: string; worktree: string; agent: boolean; account?: string | null };
/** What the prompt queue holds, and the quota windows an item can wait for. */
export type ComposerQueue = { items: readonly PromptQueueItem[]; quotas: readonly PromptQueueQuotaFact[] };
type RowState = SendResult | "sending";

export const MIN_WIDTH = 300;
export const DEFAULT_WIDTH = 520;
const MIN_BOX = 72;
const DEFAULT_BOX = 120;
const EDGE = 16;

const TONE: Record<RowState, StatusTone> = { sending: "accent", sent: "ok", unconfirmed: "warn", failed: "danger" };
const RESULT_KEY: Record<RowState, string> = {
  sending: "composer.result.sending",
  sent: "composer.result.sent",
  unconfirmed: "composer.result.unconfirmed",
  failed: "composer.result.failed",
};

const FOCUSABLE = 'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const windowWidth = () => (typeof window === "undefined" ? 1024 : window.innerWidth);
const windowHeight = () => (typeof window === "undefined" ? 768 : window.innerHeight);

/**
 * The prompt composer of one terminal tab: a floating, resizable panel. Enter sends, Shift+Enter
 * adds a line; `@` lists tabs, templates and files, `/` lists skills. With "Send to several tabs"
 * on, the prompt goes to each ticked tab, and each tab shows how its send went.
 */
export function Composer(props: {
  api: Api;
  target: ComposerTab;
  tabs: readonly ComposerTab[];
  /** Tabs ticked when it opens (Send prompt from the bulk bar); null sends to the target only. */
  initialMany: readonly string[] | null;
  send(tabId: string, text: string): Promise<SendResult>;
  /** The prompt queue; without it the composer only sends now. */
  queue?: ComposerQueue;
  onClose(): void;
}): JSX.Element {
  const { api, target, tabs } = props;
  const { t } = useI18n();
  const titleId = useId();
  const listId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const place = useRef<number | null>(null);
  const asked = useRef(new Set<"skills" | "files">());
  const draft = useDraft(api, target.id);
  const [view, setView] = useState<"compose" | "templates" | "schedule" | "queue">("compose");
  const [width, setWidth] = useState(() => Math.min(DEFAULT_WIDTH, windowWidth() - EDGE));
  const [boxHeight, setBoxHeight] = useState(DEFAULT_BOX);
  const [maxWidth, setMaxWidth] = useState(() => windowWidth() - EDGE);
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [append, setAppend] = useState<PromptTemplate[]>([]);
  const [skills, setSkills] = useState<SkillItem[] | null>(null);
  const [files, setFiles] = useState<string[] | null>(null);
  const [cursor, setCursor] = useState(0);
  const [index, setIndex] = useState(0);
  const [closed, setClosed] = useState(false);
  const [many, setMany] = useState(props.initialMany !== null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(props.initialMany ?? [target.id]));
  const [results, setResults] = useState<Record<string, RowState>>({});
  const [sentText, setSentText] = useState<string | null>(null);
  const [queued, setQueued] = useState("");
  const [queueing, setQueueing] = useState(false);
  const sending = Object.values(results).includes("sending");

  // The panel stays inside the window: a narrower window narrows it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const fit = () => {
      const max = Math.max(MIN_WIDTH, windowWidth() - EDGE);
      setMaxWidth(max);
      setWidth((w) => Math.min(w, max));
    };
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  // Focus moves in on open and back to where it was on close.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const before = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    return () => {
      if (before && before.isConnected) before.focus();
    };
  }, []);

  useEffect(() => {
    let live = true;
    api.promptTemplatesList().then(
      (list) => live && setTemplates(list),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [api]);

  // Back from the queue or the schedule, focus returns to the prompt.
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    if (view === "compose") box.current?.querySelector("textarea")?.focus();
  }, [view]);

  // After an insert the cursor goes behind it, once the new value is drawn.
  useEffect(() => {
    const area = box.current?.querySelector("textarea");
    if (place.current !== null && area) {
      area.setSelectionRange(place.current, place.current);
      place.current = null;
    }
  });

  // Skills and files load once, on the first `/` or `@`; a failure leaves the list empty.
  function need(token: Token | null) {
    if (!token) return;
    if (token.trigger === "/" && !asked.current.has("skills")) {
      asked.current.add("skills");
      api.kitSkills(target.worktree).then(
        (list) => setSkills(list.map((s) => ({ name: s.name, description: s.description }))),
        () => setSkills([]),
      );
    }
    if (token.trigger === "@" && !asked.current.has("files")) {
      asked.current.add("files");
      api.filesList(target.worktree).then(
        (list) => setFiles(list.files),
        () => setFiles([]),
      );
    }
  }

  const text = draft.text;
  const token: Token | null = closed || sending ? null : tokenAtCursor(text, cursor);
  const mentionTabs = tabs.map((x) => ({ id: x.id, label: x.label, worktree: x.worktree }));
  const matches: Mention[] = token ? mentionsFor(token, { tabs: mentionTabs, templates, files, skills }) : [];
  const open = token !== null;
  const at = matches.length === 0 ? 0 : Math.min(index, matches.length - 1);
  const optionId = (i: number) => `${listId}-${i}`;

  const track = (e: SyntheticEvent<HTMLTextAreaElement>) => {
    const pos = e.currentTarget.selectionStart;
    setCursor(pos);
    need(tokenAtCursor(text, pos));
  };

  function accept(m: Mention) {
    if (!token) return;
    const done = applyMention(text, token, m);
    place.current = done.cursor;
    draft.setText(done.text);
    setCursor(done.cursor);
    setIndex(0);
    if (done.append && !append.some((a) => a.id === done.append!.id)) setAppend([...append, done.append]);
  }

  async function sendTo(ids: readonly string[], prompt: string) {
    setSentText(prompt);
    setResults((r) => ({ ...r, ...Object.fromEntries(ids.map((id) => [id, "sending" as RowState])) }));
    const out = await Promise.all(ids.map(async (id) => [id, await props.send(id, prompt).catch((): SendResult => "failed")] as const));
    const next = Object.fromEntries(out);
    setResults((r) => ({ ...r, ...next }));
    // A send that every tab confirmed is done: the draft goes.
    if (out.every(([, r]) => r === "sent")) {
      await draft.clear();
      setAppend([]);
    }
    // Send turns disabled once the prompt is gone; focus stays in the panel.
    if (typeof document !== "undefined" && !panel.current?.contains(document.activeElement)) {
      box.current?.querySelector("textarea")?.focus();
    }
  }

  const tabItems = (props.queue?.items ?? []).filter((i) => i.tabId === target.id);
  const targets = many ? tabs.filter((x) => picked.has(x.id)).map((x) => x.id) : [target.id];
  const prompt = finalPrompt(text, append);
  const canSend = !sending && prompt !== "" && targets.length > 0;
  const canSchedule = canSend && props.queue !== undefined && !queueing;

  function send() {
    if (!canSend) return;
    setResults({});
    setQueued("");
    void sendTo(targets, prompt);
  }

  async function schedule(when: PromptQueueWhenInput) {
    if (!props.queue || !canSchedule) return;
    setQueueing(true);
    try {
      for (const id of targets) await api.promptQueueAdd({ tabId: id, text: prompt, when });
      await draft.clear();
      setAppend([]);
      setQueued(t("composer.queue.added", { count: targets.length }));
      setView("compose");
    } catch (err) {
      setQueued(t(toApiError(err).code === "too_large" ? "composer.queue.tooLarge" : "composer.queue.failed"));
      setView("compose");
    } finally {
      setQueueing(false);
    }
  }

  const failed = retryTargets(Object.fromEntries(Object.entries(results).filter((e): e is [string, SendResult] => e[1] !== "sending")));
  const showRetry = !sending && failed.length > 0 && sentText !== null;

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return;
    if (open) {
      const result = completionKey(e.key, at, matches.length);
      if (result) {
        e.preventDefault();
        e.stopPropagation();
        if (result.action === "accept") accept(matches[result.index]!);
        else if (result.action === "close") setClosed(true);
        else setIndex(result.index);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      send();
    }
  }

  function onChange(e: ChangeEvent<HTMLTextAreaElement>) {
    draft.setText(e.target.value);
    setCursor(e.target.selectionStart);
    setIndex(0);
    setClosed(false);
    need(tokenAtCursor(e.target.value, e.target.selectionStart));
  }

  // The panel's own focus loop (APG dialog): Tab wraps, Escape closes.
  function onPanelKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
      return;
    }
    if (e.key !== "Tab" || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest("[hidden]"));
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const agentIds = tabs.filter((x) => x.agent).map((x) => x.id);
  const agentsPicked = agentIds.filter((id) => picked.has(id)).length;
  const toggle = (id: string, on: boolean) =>
    setPicked((p) => {
      const next = new Set(p);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const toggleAgents = (on: boolean) =>
    setPicked((p) => {
      const next = new Set(p);
      for (const id of agentIds) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const done = Object.values(results).filter((r) => r !== "sending");
  const sentCount = done.filter((r) => r === "sent").length;
  const status = sending
    ? t("composer.status.sending")
    : done.length === 0
      ? ""
      : !many && done.length === 1
        ? t(RESULT_KEY[done[0]!])
        : t("composer.status.summary", { sent: sentCount, count: done.length });

  return (
    <div
      ref={panel}
      className="composer"
      role="dialog"
      aria-labelledby={titleId}
      style={{ width: `${width}px` }}
      onKeyDown={onPanelKey}
      data-testid="composer"
    >
      <SplitHandle
        className="composer-resize-x"
        direction="horizontal"
        value={width}
        min={Math.min(MIN_WIDTH, maxWidth)}
        max={maxWidth}
        reverse
        label={t("composer.resizeWidth")}
        onResize={setWidth}
      />
      <header className="composer-head">
        <h2 id={titleId} className="composer-title">
          {view === "templates" ? t("composer.templates.title") : view === "schedule" ? t("composer.schedule.title") : view === "queue" ? t("composer.queue.title") : t("composer.title", { tab: target.label })}
        </h2>
        {view === "compose" && <IconButton icon="list" label={t("composer.templates.open")} onClick={() => setView("templates")} />}
        <IconButton icon="close" label={t("composer.close")} onClick={props.onClose} />
      </header>
      {view === "templates" ? (
        <TemplatesManager api={api} templates={templates} onChange={setTemplates} onBack={() => setView("compose")} />
      ) : view === "schedule" && props.queue ? (
        <div className="composer-templates">
          <ScheduleForm
            account={target.account ?? null}
            quotas={props.queue.quotas}
            confirmLabel={t("composer.schedule.confirm", { count: targets.length })}
            disabled={queueing}
            onCancel={() => setView("compose")}
            onSubmit={(when) => void schedule(when)}
          />
        </div>
      ) : view === "queue" && props.queue ? (
        <QueuePanel api={api} items={tabItems} account={target.account ?? null} quotas={props.queue.quotas} onBack={() => setView("compose")} />
      ) : (
        <div className="composer-body">
          <SplitHandle
            className="composer-resize-y"
            direction="vertical"
            value={boxHeight}
            min={MIN_BOX}
            max={Math.max(MIN_BOX, Math.floor(windowHeight() * 0.6))}
            reverse
            label={t("composer.resizeHeight")}
            onResize={setBoxHeight}
          />
          <div className="composer-box" ref={box}>
            <Textarea
              mono
              rows={4}
              resize="none"
              style={{ height: boxHeight }}
              label={t("composer.prompt")}
              hint={t("composer.prompt.hint")}
              error={draft.error === "too_large" ? t("composer.draft.tooLarge") : undefined}
              value={text}
              readOnly={sending}
              role="combobox"
              aria-expanded={open}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={open && matches.length > 0 ? optionId(at) : undefined}
              onChange={onChange}
              onKeyDown={onKeyDown}
              onKeyUp={track}
              onClick={track}
            />
            {open && (
              <div className="agent-launch-complete composer-complete">
                <ul id={listId} role="listbox" aria-label={t(token?.trigger === "/" ? "agentLaunch.complete.skills" : "composer.complete.mentions")}>
                  {matches.map((m, i) => (
                    <li key={m.key} id={optionId(i)} role="option" aria-selected={i === at} onMouseDown={(e) => e.preventDefault()}>
                      <ListRow
                        title={<span className="ws-mono">{m.kind === "file" || m.kind === "skill" ? token!.trigger + m.label : m.label}</span>}
                        meta={m.kind === "skill" ? m.description : t(`composer.mention.${m.kind}`)}
                        selected={i === at}
                        onClick={() => accept(m)}
                      />
                    </li>
                  ))}
                </ul>
                {matches.length === 0 && (
                  <p className="agent-launch-complete-status" role="status">
                    {(token?.trigger === "/" ? skills : files) === null ? t("agentLaunch.complete.loading") : t("agentLaunch.complete.empty")}
                  </p>
                )}
              </div>
            )}
          </div>
          {append.length > 0 && (
            <div className="composer-append" aria-label={t("composer.append.label")} role="group">
              <span>{t("composer.append.label")}</span>
              {append.map((a) => (
                <Tag key={a.id} onRemove={() => setAppend(append.filter((x) => x.id !== a.id))} removeLabel={t("composer.append.remove", { name: a.name })}>
                  {a.name}
                </Tag>
              ))}
            </div>
          )}
          <Checkbox label={t("composer.many")} checked={many} onChange={(e) => setMany(e.target.checked)} disabled={sending} />
          {many && (
            <fieldset className="composer-targets">
              <legend>{t("composer.many.legend")}</legend>
              {agentIds.length > 0 && (
                <Checkbox
                  label={t("composer.many.allAgents")}
                  checked={agentsPicked === agentIds.length}
                  indeterminate={agentsPicked > 0 && agentsPicked < agentIds.length}
                  disabled={sending}
                  onChange={(e) => toggleAgents(e.target.checked)}
                />
              )}
              <ul className="composer-target-list">
                {tabs.map((x) => (
                  <li key={x.id} data-testid="composer-target">
                    <Checkbox label={x.label} checked={picked.has(x.id)} disabled={sending} onChange={(e) => toggle(x.id, e.target.checked)} />
                    {results[x.id] && <StatusDot tone={TONE[results[x.id]!]} label={t(RESULT_KEY[results[x.id]!])} />}
                  </li>
                ))}
              </ul>
            </fieldset>
          )}
          <div className="composer-actions">
            {showRetry && (
              <Button type="button" variant="secondary" icon="refresh" onClick={() => void sendTo(failed, sentText!)}>
                {t("composer.retry", { count: failed.length })}
              </Button>
            )}
            {props.queue && (
              <Button type="button" variant="secondary" icon="list" onClick={() => setView("queue")} data-testid="composer-queue-open">
                {tabItems.length > 0 ? t("composer.queue.open.count", { count: tabItems.length }) : t("composer.queue.open")}
              </Button>
            )}
            {props.queue && (
              <Button type="button" variant="secondary" icon="clock" disabled={!canSchedule} onClick={() => setView("schedule")} data-testid="composer-schedule-open">
                {t("composer.schedule.open")}
              </Button>
            )}
            <Button variant="primary" type="button" icon="send" disabled={!canSend} onClick={send}>
              {many ? t("composer.sendMany", { count: targets.length }) : t("composer.send")}
            </Button>
          </div>
          <p className="composer-status" role="status" data-testid="composer-status">
            {status || queued}
          </p>
        </div>
      )}
    </div>
  );
}
