import { useCallback, useEffect, useRef, useState } from "react";
import type { Api, PromptQueueItem, Quota } from "@/api";
import type { Sessions } from "@/workspace/sessions";
import { FACTS_EVERY_MS, QUOTA_EVERY_MS, buildFacts } from "./queue";
import type { SendResult } from "./verify";

export type Queue = {
  items: readonly PromptQueueItem[];
  quotas: readonly Quota[];
  /** False until the first read of the queue has come back. */
  loaded: boolean;
};

/**
 * The window's half of the prompt queue: it keeps the backend told which tabs are live and idle and
 * what the 5-hour windows say, sends the items the backend says are due (with the composer's
 * verified send) and reports how each went. Also returns the queue, kept up to date.
 */
export function useQueue(api: Api, sessions: Sessions | null, send: (tabId: string, text: string) => Promise<SendResult>): Queue {
  const [items, setItems] = useState<readonly PromptQueueItem[]>([]);
  const [quotas, setQuotas] = useState<readonly Quota[]>([]);
  const [loaded, setLoaded] = useState(false);
  const quotasRef = useRef<readonly Quota[]>([]);
  const sendRef = useRef(send);
  sendRef.current = send;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const lastFacts = useRef("");

  const read = useCallback(() => {
    api.promptQueueList().then(
      (list) => {
        setItems(list);
        setLoaded(true);
      },
      () => setLoaded(true),
    );
  }, [api]);

  useEffect(() => {
    read();
    let off = () => {};
    let gone = false;
    void api.onPromptQueueChanged(read).then((un) => (gone ? un() : (off = un)));
    return () => {
      gone = true;
      off();
    };
  }, [api, read]);

  // What only the window knows: pushed on change and at least every FACTS_EVERY_MS.
  const push = useCallback(
    (force: boolean) => {
      const s = sessionsRef.current;
      const tabs = s ? s.worktrees().flatMap((w) => s.tabs(w)).filter((tab) => !tab.asleep && tab.exitCode === undefined) : [];
      const facts = buildFacts(tabs, quotasRef.current);
      const key = JSON.stringify(facts);
      if (!force && key === lastFacts.current) return;
      lastFacts.current = key;
      void api.promptQueueFacts(facts).catch(() => {
        lastFacts.current = "";
      });
    },
    [api],
  );

  useEffect(() => {
    push(true);
    const off = sessions ? sessions.subscribe(() => push(false)) : () => {};
    const timer = setInterval(() => push(true), FACTS_EVERY_MS);
    return () => {
      off();
      clearInterval(timer);
    };
  }, [sessions, push]);

  const waitsForReset = items.some((i) => i.when.kind === "after_reset" && i.status === "waiting");
  useEffect(() => {
    let live = true;
    const get = () =>
      api.quota().then(
        (q) => {
          if (!live) return;
          quotasRef.current = q;
          setQuotas(q);
          push(false);
        },
        () => {},
      );
    void get();
    if (!waitsForReset) return () => void (live = false);
    const timer = setInterval(() => void get(), QUOTA_EVERY_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api, waitsForReset, push]);

  useEffect(() => {
    let off = () => {};
    let gone = false;
    void api
      .onPromptQueueDue(({ items: due }) => {
        for (const item of due) {
          void sendRef
            .current(item.tabId, item.text)
            .catch((): SendResult => "failed")
            .then((result) => api.promptQueueReport(item.id, result))
            .catch(() => {});
        }
      })
      .then((un) => (gone ? un() : (off = un)));
    return () => {
      gone = true;
      off();
    };
  }, [api]);

  return { items, quotas, loaded };
}
