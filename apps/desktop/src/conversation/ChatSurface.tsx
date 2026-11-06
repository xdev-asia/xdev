import { Button, EmptyState, Textarea } from "@xdev-asia/ui";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import type { Api } from "@/api";
import { sendToTab } from "@/composer/ComposerHost";
import type { SendResult } from "@/composer/verify";
import { useI18n } from "@/i18n";
import { terminalOf } from "@/terminal/terminalRegistry";
import { sessionFallback } from "@/workspace/layoutPersist";
import { runAccount, type Sessions, type Tab } from "@/workspace/sessions";
import { CHAT_POLL_MS, resumeFailed } from "./chatOpen";
import { ConversationView } from "./ConversationView";
import { feedQuestions } from "./questionStore";

/** How many times a chat with no known session looks one up by itself. */
export const ADOPT_MAX = 15;

type T = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Sends one draft. A blank draft sends nothing. The note is the one status line; the draft is kept only
 * when the send failed.
 */
export async function submit(
  draft: string,
  deps: { id: string; send: (id: string, text: string) => Promise<SendResult>; t: T },
): Promise<{ sent: boolean; clear: boolean; note: string }> {
  const text = draft.trim();
  if (!text) return { sent: false, clear: false, note: "" };
  const result = await deps.send(deps.id, text);
  if (result === "failed") return { sent: true, clear: false, note: deps.t("chat.sent.failed") };
  return { sent: true, clear: true, note: result === "unconfirmed" ? deps.t("chat.sent.unconfirmed") : "" };
}

/** Enter sends; Shift+Enter adds a line; a key that is part of an IME composition does nothing. */
export function composerKey(e: { key: string; shiftKey: boolean; isComposing?: boolean; nativeEvent?: { isComposing?: boolean } }): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.isComposing && !e.nativeEvent?.isComposing;
}

type Every = (fn: () => void, ms: number) => () => void;
const realEvery: Every = (fn, ms) => {
  const h = setInterval(fn, ms);
  return () => clearInterval(h);
};

/**
 * Looks a session up now and then, until one is found or `max` looks were made. `count` is shared between runs
 * so a restart of the loop does not reset the cap. Returns its stop.
 */
export function adoptLoop(o: { look: () => Promise<string | null>; adopt: (id: string) => void; count: { n: number }; max?: number; ms?: number; every?: Every }): () => void {
  const max = o.max ?? ADOPT_MAX;
  let live = true;
  let stop = () => {};
  const once = async () => {
    if (!live || o.count.n >= max) return stop();
    o.count.n++;
    const id = await o.look().catch(() => null);
    if (!live) return;
    if (id) {
      o.adopt(id);
      stop();
    }
  };
  void once();
  stop = (o.every ?? realEvery)(() => void once(), o.ms ?? CHAT_POLL_MS);
  return () => {
    live = false;
    stop();
  };
}

type ChatApi = Pick<Api, "agentConversation" | "fileLinksResolve" | "openUrl" | "agentSessions"> & Partial<Pick<Api, "ptyWrite" | "composerDraftPut" | "onPtyHook">>;

/**
 * The chat view of an agent tab: the conversation and a composer, over the tab's terminal. The terminal and its
 * pty stay mounted underneath, so switching back loses nothing.
 */
export function ChatSurface(props: { api: ChatApi; sessions: Sessions; tab: Tab; agentName: string; now?: number }): JSX.Element {
  const { api, sessions, tab, agentName } = props;
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState("");
  const [sends, setSends] = useState(0);
  const count = useRef({ n: 0 });
  const ended = tab.exitCode !== undefined;
  const failed = resumeFailed(tab, props.now ?? Date.now());

  useEffect(() => {
    if (api.onPtyHook) feedQuestions(api as Pick<Api, "onPtyHook">);
  }, [api]);

  // Covered, the terminal leaves the tab order and the reading order.
  useLayoutEffect(() => {
    const term = ref.current?.parentElement?.querySelector(":scope > .terminal-pane");
    if (!term) return;
    term.setAttribute("inert", "");
    return () => term.removeAttribute("inert");
  }, []);

  // With the hooks off nothing reports the session: look for it after each send and now and then.
  const { id, worktree, cli, openedAt, agentSession } = tab;
  useEffect(() => {
    if (agentSession !== null || !cli) return;
    const fallback = sessionFallback(api);
    return adoptLoop({ look: () => fallback(worktree, cli, openedAt), adopt: (s) => sessions.adoptSession(id, s), count: count.current });
  }, [api, sessions, id, worktree, cli, openedAt, agentSession, sends]);

  // The composer takes the keyboard when the chat opens.
  useEffect(() => {
    area.current?.focus();
  }, [id]);

  const toTerminal = useCallback(() => {
    sessions.setView(id, "terminal");
    setTimeout(() => terminalOf(id)?.focus(), 0);
  }, [sessions, id]);
  const fresh = () => sessions.restartAs(id, runAccount(tab), true);

  async function send(): Promise<void> {
    const out = await submit(draft, { id, send: (tabId, text) => sendToTab(sessions, tabId, text), t });
    if (!out.sent) return;
    if (out.clear) setDraft("");
    setNote(out.note);
    setSends((n) => n + 1);
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!composerKey(e)) return;
    e.preventDefault();
    void send();
  };

  const missing = useCallback(
    () => api.agentSessions({ text: null, scope: { kind: "worktree", path: worktree }, agent: cli, homeId: null, sort: "firstDesc", limit: 1 }, true),
    [api, worktree, cli],
  );

  return (
    <div ref={ref} className="cv-chat" data-testid="chat-surface" role="region" aria-label={t("chat.region", { name: agentName })}>
      {agentSession === null ? (
        <div className="cv-chat-wait">
          <EmptyState title={t("chat.starting", { name: agentName })} hint={t("chat.starting.hint")} />
        </div>
      ) : (
        <ConversationView
          api={api}
          tab={{ id, agentSession, status: tab.status, worktree, ...(cli ? { cli } : {}) }}
          agentName={agentName}
          mode="tab"
          pollMs={CHAT_POLL_MS}
          onMissing={missing}
          onBack={toTerminal}
          onNewConversation={fresh}
        />
      )}
      {failed ? (
        <EmptyState
          title={t("chat.resumeFailed")}
          hint={t("chat.resumeFailed.hint")}
          actions={
            <>
              <Button type="button" variant="primary" onClick={fresh}>
                {t("chat.startNew")}
              </Button>
              <Button type="button" variant="secondary" onClick={toTerminal}>
                {t("chat.showTerminal")}
              </Button>
            </>
          }
        />
      ) : (
        <form
          className="cv-chat-composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <Textarea
            ref={area}
            label={t("chat.composer.label", { name: agentName })}
            hint={ended ? t("chat.ended") : t("chat.composer.hint")}
            rows={2}
            resize="none"
            value={draft}
            disabled={ended}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={onKeyDown}
          />
          <Button type="submit" variant="primary" disabled={ended}>
            {t("chat.send")}
          </Button>
          <small role="status">{note}</small>
        </form>
      )}
    </div>
  );
}
