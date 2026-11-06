import { useCallback, useEffect, useRef, useState } from "react";
import { toApiError, type Api } from "@/api";
import { profileName } from "@/agents/profileStore";
import { useI18n } from "@/i18n";
import { PLATFORM } from "@/platform";
import { writeImagePath } from "@/terminal/clipboardPaste";
import { shellKindFor } from "@/terminal/pathPaste";
import { pushToast } from "@/workspace/toastStore";
import type { Sessions, Tab } from "@/workspace/sessions";
import { registerAnnotator } from "./annotateBridge";
import type { Shape } from "./annotModel";
import { exportPng } from "./exportPng";
import type { Colors, Drawable } from "./render";

const liveAgent = (tab: Tab): boolean => tab.agent && tab.exitCode === undefined && !tab.asleep;

/** The agent tab a capture goes to: the one in front when it is one, else the most recent agent tab of the worktree. */
export function captureTarget(tabs: readonly Tab[], shown: string | null): Tab | null {
  const front = tabs.find((tab) => tab.id === shown);
  if (front && liveAgent(front)) return front;
  return tabs.filter(liveAgent).at(-1) ?? null;
}

/** The path to hand on: the original while nothing was drawn, else a new PNG with the shapes in it. */
export async function finalPath(deps: { api: Pick<Api, "captureSavePng">; exportPng(): Promise<Uint8Array> }, path: string, shapes: readonly Shape[]): Promise<string> {
  return shapes.length === 0 ? path : deps.api.captureSavePng(await deps.exportPng());
}

export interface SendDeps {
  api: Pick<Api, "captureSavePng">;
  sessions: Pick<Sessions, "tabs">;
  /** The worktree on screen; null when none. */
  worktree: string | null;
  /** Its front tab. */
  shown: string | null;
  exportPng(): Promise<Uint8Array>;
  /** Whether the tab's program turned bracketed paste on. */
  bracketed(tab: Tab): boolean;
  windows: boolean;
  notify(key: string, vars?: Record<string, string>): void;
  tabTitle(tab: Tab): string;
}

export type SendOutcome = "sent" | "no-tab" | "failed";

/** Writes the capture's path into the agent tab, as a pasted image path does. */
export async function sendCapture(deps: SendDeps, path: string, shapes: readonly Shape[]): Promise<SendOutcome> {
  const tab = deps.worktree ? captureTarget(deps.sessions.tabs(deps.worktree), deps.shown) : null;
  if (!tab) {
    deps.notify("capture.noTab");
    return "no-tab";
  }
  try {
    const sent = await finalPath(deps, path, shapes);
    const written = await writeImagePath(
      { writeRaw: (data) => tab.client.input(data), shell: () => shellKindFor("", true, deps.windows), bracketedMode: () => deps.bracketed(tab) },
      sent,
    );
    if (!written) throw new Error("path");
  } catch {
    deps.notify("capture.err.failed");
    return "failed";
  }
  deps.notify("capture.sent", { tab: deps.tabTitle(tab) });
  return "sent";
}

export type Session = { path: string; image: Drawable; mode: "paste" | "send" };

export interface CaptureHostProps {
  api: Pick<Api, "captureRead" | "captureSavePng" | "captureSettings" | "onCaptureReady">;
  sessions: () => Sessions | null;
  /** The path of the worktree on screen. */
  current: () => string | null;
  /** Its front tab. */
  shownTab: () => string | null;
  /** Bytes to a bitmap; tests pass their own. */
  decode?: (bytes: Uint8Array) => Promise<Drawable>;
}

const decodePng = (bytes: Uint8Array): Promise<Drawable> => createImageBitmap(new Blob([bytes as BlobPart], { type: "image/png" }));

/** Opens the annotate dialog for each capture and pasted image, and sends the result. */
export function useCaptureHost(props: CaptureHostProps): {
  session: Session | null;
  discard(): void;
  send(shapes: readonly Shape[], colors: Colors): Promise<void>;
} {
  const { t } = useI18n();
  const live = useRef({ props, t });
  live.current = { props, t };
  const [session, setSession] = useState<Session | null>(null);
  // Settles the paste that opened the dialog.
  const settle = useRef<((path: string | null) => void) | null>(null);
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;

  const close = useCallback((result: string | null) => {
    const done = settle.current;
    settle.current = null;
    setSession(null);
    done?.(result);
  }, []);

  const open = useCallback(
    async (path: string, mode: Session["mode"]): Promise<string | null> => {
      const { api, decode } = live.current.props;
      settle.current?.(null);
      settle.current = null;
      let image: Drawable;
      try {
        image = await (decode ?? decodePng)(await api.captureRead(path));
      } catch (e) {
        const { t: tr } = live.current;
        pushToast({ text: tr(toApiError(e).code === "too_large" ? "capture.err.tooLarge" : "capture.err.failed") });
        return null;
      }
      return new Promise<string | null>((resolve) => {
        settle.current = resolve;
        setSession({ path, image, mode });
      });
    },
    [],
  );

  const { api } = props;
  useEffect(() => {
    let alive = true;
    let stop: (() => void) | undefined;
    // A screenshot from the shortcut or the palette goes to an agent tab.
    void api.onCaptureReady((e) => void open(e.path, "send")).then((off) => {
      if (alive) stop = off;
      else off();
    });
    const unregister = registerAnnotator({
      open,
      pasteEnabled: async () => (await live.current.props.api.captureSettings()).annotatePaste,
    });
    return () => {
      alive = false;
      stop?.();
      unregister();
    };
  }, [api, open]);

  const discard = useCallback(() => close(null), [close]);

  const send = useCallback(
    async (shapes: readonly Shape[], colors: Colors) => {
      const current = sessionRef.current;
      if (!current) return;
      const { props: p, t: tr } = live.current;
      const image = current.image;
      const render = () => exportPng(image, shapes, colors);
      if (current.mode === "paste") {
        // The paste writes the path into its own terminal.
        try {
          close(await finalPath({ api: p.api, exportPng: render }, current.path, shapes));
        } catch {
          pushToast({ text: tr("capture.err.failed") });
        }
        return;
      }
      const sessions = p.sessions();
      if (!sessions) return;
      const outcome = await sendCapture(
        {
          api: p.api,
          sessions,
          worktree: p.current(),
          shown: p.shownTab(),
          exportPng: render,
          // An agent CLI turns bracketed paste on when it starts.
          bracketed: () => true,
          windows: PLATFORM === "win",
          notify: (key, vars) => pushToast({ text: tr(key, vars) }),
          tabTitle: (tab) => tab.title ?? profileName(null, tab.profileId, tr),
        },
        current.path,
        shapes,
      );
      if (outcome === "sent") close(current.path);
    },
    [close],
  );

  return { session, discard, send };
}
