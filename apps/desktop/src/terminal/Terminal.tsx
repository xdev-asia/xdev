import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useImperativeHandle, useRef, useState } from "react";
import type { JSX, Ref } from "react";
import { toApiError, type Api, type ApiError, type PtyInfo, type PtyProfile } from "@/api";
import { openFile } from "@/files/openFile";
import { useI18n } from "@/i18n";
import { appOwnsKey } from "@/keys/keymap";
import { IS_MAC, PLATFORM } from "@/platform";
import { copyText } from "@/ui/clipboard";
import type { MenuItem } from "@/ui/ContextMenu";
import { pushToast } from "@/workspace/toastStore";
import { PtyClient } from "./ptyClient";
import { createTerminalHandle } from "./terminalActions";
import { getCustomSchemes, subscribeCustomSchemes } from "./customSchemes";
import { getTerminalSettings, subscribeTerminalSettings } from "./terminalSettings";
import { decodeOsc52Write, themeIdFor, xtermOptions } from "./terminalOptions";
import { TerminalFind } from "./TerminalFind";
import { installStatusOsc, type ProgramReport } from "./statusOsc";
import { createBell } from "./terminalBell";
import { attachRenderer } from "./terminalRenderer";
import { appIsLight, followAppTheme } from "./terminalColors";
import { createFileLinkProvider, createLinkResolver, createOscLinkHandler, cwdFromOsc7, urlLinkOptions, type TermLinksEnv } from "./termLinks";
import { annotatePasted } from "@/capture/annotateBridge";
import { middlePasteText } from "./middlePaste";
import { pasteClipboard, type PasteResult } from "./clipboardPaste";
import { registerDropTarget } from "./fileDrop";
import { trackInputModes } from "./inputModes";
import { shellKindFor, type ShellKind } from "./pathPaste";
import { effectiveOptionAsAlt, getDetectedLayout, subscribeDetectedLayout } from "./optionAsAlt";
import { createOptionSideTracker, resolveTerminalKey } from "./terminalKeys";

/** What a menu, the palette or a shortcut can do to one terminal. Acts on the xterm; nothing goes to the pty unless said. */
export interface TerminalHandle {
  /** Copies the selection; false when nothing is selected. */
  copy(): Promise<boolean>;
  /** Clipboard text through xterm's paste, so bracketed paste applies. */
  paste(): Promise<void>;
  selectAll(): void;
  /** `term.clear()`; nothing written to the pty. */
  clear(): void;
  /** `term.reset()`, then the size sent again so the program redraws; nothing written to the pty. */
  reset(): void;
  /** Opens the find bar, as Ctrl+F does. */
  find(): void;
  hasSelection(): boolean;
  /** The selected text; "" when nothing is selected. Absent in a stand-in handle. */
  selectionText?(): string;
  focus(): void;
  /** The last `max` lines of the buffer, blank tail lines dropped (for Copy Context). */
  lines(max: number): string[];
}

/**
 * One running pty in an xterm. Starts on mount. Kills the pty on unmount, unless the pty
 * belongs to a `client` passed in: that one lives on with its owner.
 */
export function Terminal(props: {
  api: Api;
  id: string;
  /** The tab's own client; without one the view makes and owns a client for `id`. */
  client?: PtyClient;
  cwd: string;
  profile: PtyProfile;
  account?: string | null;
  onStarted(info: PtyInfo): void;
  onError(error: ApiError): void;
  /** Bytes of pty output, as they arrive. */
  onOutput?(bytes: number): void;
  /** The user typed into the terminal; `text` is what was sent (Escape alone may stop a turn). */
  onInput?(text: string): void;
  /** The program set the terminal title (OSC 0 or 2). */
  onTitle?(title: string): void;
  /** The program rang the terminal bell (BEL outside an OSC string; xterm tells the two apart). */
  onBell?(): void;
  /** The program reported its own status (OSC 7501). */
  onProgramStatus?(report: ProgramReport): void;
  /** The program reported progress (OSC 9;4): a percent, null to clear, "keep" to leave it. */
  onProgress?(progress: number | null | "keep"): void;
  /** A new value asks the terminal to take keyboard focus; the first value alone asks nothing. */
  focusSeq?: number;
  /** Filled with this terminal's handle. */
  handleRef?: Ref<TerminalHandle>;
  /**
   * A right click asks for the menu: always when right-click paste is off, Shift+right-click when it is on.
   * Without it the right click is left to the webview, as before.
   */
  onMenu?: (at: { x: number; y: number }, handle: TerminalHandle) => void;
  /** The worktree file links resolve in; without it a file path is plain text (a URL still links). */
  worktree?: string;
  /** A plain click on a link asks for its action menu; without it the click opens the link. */
  onLinkMenu?: (at: { x: number; y: number }, items: MenuItem[], title: string) => void;
  /** The menu's "Terminal link settings" row. */
  onLinkSettings?: () => void;
}): JSX.Element {
  const { t } = useI18n();
  // The hover tip of a link, drawn at the pane's bottom left.
  const [tip, setTip] = useState<string | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const search = useRef<SearchAddon | null>(null);
  const xterm = useRef<XTerm | null>(null);
  const seen = useRef(props.focusSeq);
  // The find bar: open or not, what it opens with, and a counter that re-focuses it (Ctrl+F while open).
  const [find, setFind] = useState({ open: false, initial: "", seq: 0 });
  const lastQuery = useRef("");
  // Callbacks change every render; the effect below runs once per pty.
  const handlers = useRef(props);
  handlers.current = props;
  const clientRef = useRef<PtyClient | null>(null);
  // The quoting kind of the running program, known once the pty has started.
  const shellKind = useRef<ShellKind>("unknown");
  // An agent CLI runs in the pane; until the pty reports it, a non-shell profile is taken as one.
  const isAgent = useRef(props.profile !== "shell");
  // Link and paste toasts read the live translator.
  const tRef = useRef(t);
  tRef.current = t;
  // A paste that saved nothing says why; the others are silent.
  const reportPaste = (result: PasteResult) => {
    if (result === "too_large") pushToast({ text: tRef.current("terminal.input.imageTooLarge") });
    else if (result === "failed") pushToast({ text: tRef.current("terminal.input.imageSaveFailed") });
  };
  const reportPasteRef = useRef(reportPaste);
  reportPasteRef.current = reportPaste;
  // Opens the find bar, or focuses it when open. A one-line selection becomes the query.
  const openFind = () => {
    const selected = xterm.current?.getSelection() ?? "";
    const seed = selected && !/[\r\n]/.test(selected) ? selected : lastQuery.current;
    setFind((f) => ({ open: true, initial: f.open ? f.initial : seed, seq: f.seq + 1 }));
  };
  const openFindRef = useRef(openFind);
  openFindRef.current = openFind;
  // One handle per view; it reads the live xterm on each call.
  const handle = useRef(
    createTerminalHandle({
      term: () => xterm.current,
      client: () => clientRef.current,
      find: () => openFindRef.current(),
      saveImage: () => handlers.current.api.clipboardImageSave(),
      shell: () => shellKind.current,
      pasted: (result) => reportPasteRef.current(result),
      annotate: annotatePasted,
    }),
  );
  useImperativeHandle(props.handleRef, () => handle.current, []);

  // Declared before the pty effect, which owns the xterm this one focuses.
  useEffect(() => {
    if (props.focusSeq === seen.current) return;
    seen.current = props.focusSeq;
    if (props.focusSeq) xterm.current?.focus();
  }, [props.focusSeq]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const css = getComputedStyle(el);
    const color = (name: string) => css.getPropertyValue(name).trim() || undefined;
    const mono = color("--x-font-mono");
    const initial = xtermOptions(getTerminalSettings(), mono, color, getCustomSchemes(), appIsLight());
    // The padding around the terminal: the host sits this far inside the pane.
    const applyInset = () => {
      el.style.inset = `${getTerminalSettings().paddingPx}px`;
    };
    applyInset();
    // File paths, URLs and OSC 8 links; the hover tip is a state of the pane.
    // The shell's folder, from its OSC 7 reports; relative paths in output are read against it.
    let shellCwd: string | undefined;
    const links: TermLinksEnv = {
      worktree: () => handlers.current.worktree,
      buffer: () => xterm.current!.buffer.active,
      cwd: () => shellCwd,
      resolve: createLinkResolver((worktree, paths, cwd) => handlers.current.api.fileLinksResolve(worktree, paths, cwd)),
      settings: () => {
        const { linkClick, urlMiddleClick } = getTerminalSettings();
        return { linkClick, urlMiddleClick };
      },
      mac: IS_MAC,
      deps: {
        api: {
          fileOpenDefault: (worktree, rel) => handlers.current.api.fileOpenDefault(worktree, rel),
          fileReveal: (worktree, rel) => handlers.current.api.fileReveal(worktree, rel),
          openUrl: (url) => handlers.current.api.openUrl(url),
        },
        openFile,
        copyText,
        toast: (text) => void pushToast({ text }),
        t: (key, vars) => tRef.current(key, vars),
        mac: IS_MAC,
        onSettings: () => handlers.current.onLinkSettings?.(),
        focusTerminal: () => xterm.current?.focus(),
      },
      showMenu: (at, menu) => {
        const show = handlers.current.onLinkMenu;
        show?.(at, menu.items, menu.title);
        return show !== undefined;
      },
      tip: setTip,
    };
    // Proposed API: search decorations (and with them the match count) need it.
    const term = new XTerm({ ...initial, allowProposedApi: true, linkHandler: createOscLinkHandler(links) });
    // The pane and the padding around the host take the theme's background (the app theme: the CSS one).
    const pane = el.parentElement;
    const paint = (background: string | undefined) => {
      const s = getTerminalSettings();
      // Below full opacity the theme background carries the alpha, so the pane must not add its own.
      const own = s.backgroundOpacity >= 1 && background && themeIdFor(s, appIsLight()) !== "app";
      if (pane) pane.style.background = own ? background : "";
    };
    paint(initial.theme.background);
    const bell = createBell(pane ?? el, { mode: () => getTerminalSettings().bell });
    const fit = new FitAddon();
    const finder = new SearchAddon({ highlightLimit: 1000 });
    search.current = finder;
    xterm.current = term;
    term.loadAddon(fit);
    term.loadAddon(finder);
    // No opener plugin in the app: a click goes to a command that starts the system browser.
    const urls = urlLinkOptions(links);
    term.loadAddon(new WebLinksAddon(urls.handler, { hover: urls.hover, leave: urls.leave }));
    term.registerLinkProvider(createFileLinkProvider(links));
    term.open(el);
    // WebGL or DOM, as Settings says; after `open`, which the addon needs.
    const renderer = attachRenderer(term, getTerminalSettings().gpu);
    // What the program asked for (kitty flags, modifyOtherKeys) and which Option keys are held.
    const modes = trackInputModes(term);
    const optionSides = createOptionSideTracker();
    // The program is gone: its keyboard modes go with it.
    let offExit: (() => void) | null = null;
    let exitGone = false;
    void props.api
      .onPtyExit((exit) => {
        if (exit.id === props.id) modes.reset();
      })
      .then((off) => {
        if (exitGone) off();
        else offExit = off;
      })
      .catch(() => {});
    const effectiveOption = () => effectiveOptionAsAlt(getTerminalSettings().macOptionAsAlt, getDetectedLayout());
    // With both Option keys as Alt, xterm itself encodes Option+key as ESC + key.
    const applyOptionMeta = () => {
      term.options.macOptionIsMeta = PLATFORM === "mac" && effectiveOption() === "both";
    };
    applyOptionMeta();
    const offLayout = subscribeDetectedLayout(applyOptionMeta);
    const clearOptionSides = () => optionSides.clear();
    el.addEventListener("focusout", clearOptionSides);
    // A chord the app owns (per the key policy) never reaches the program: a terminal action runs
    // here, any other one has run in the window handler before xterm saw it.
    term.attachCustomKeyEventHandler((e) => {
      if (e.key === "Alt") {
        if (e.type === "keydown") optionSides.down(e);
        else if (e.type === "keyup") optionSides.up(e);
      }
      if (e.type !== "keydown") return true;
      const action = appOwnsKey(e);
      if (action === null) {
        const resolved = resolveTerminalKey(e, {
          platform: PLATFORM,
          optionAsAlt: effectiveOption(),
          optionSide: optionSides.get(),
          kittyFlags: modes.kittyFlags(),
          modifyOtherKeys: modes.modifyOtherKeys(),
          alternateScreen: term.buffer.active.type === "alternate",
          agent: isAgent.current,
        });
        if (resolved === null) return true;
        if (resolved.type === "scroll") {
          if (resolved.to === "top") term.scrollToTop();
          else term.scrollToBottom();
        } else {
          handlers.current.onInput?.(resolved.data);
          void client.input(resolved.data).catch(() => {});
        }
        e.preventDefault();
        return false;
      }
      switch (action) {
        case "terminal.find":
          openFindRef.current();
          break;
        case "terminal.clear":
          term.clear();
          break;
        case "terminal.selectAll":
          term.selectAll();
          break;
        case "terminal.copy": {
          const text = term.getSelection();
          if (text) void navigator.clipboard?.writeText(text).catch(() => {});
          break;
        }
        case "terminal.paste":
          void handle.current.paste();
          break;
        default:
          return false;
      }
      // The browser's own paste or select-all would act as well.
      e.preventDefault();
      return false;
    });
    term.onSelectionChange(() => {
      const text = term.getSelection();
      if (text && getTerminalSettings().copyOnSelect) void navigator.clipboard?.writeText(text).catch(() => {});
    });
    term.parser.registerOscHandler(7, (data) => {
      shellCwd = cwdFromOsc7(data) ?? shellCwd;
      return true;
    });
    // Restored output is replayed through the parser: its probes were answered the first time.
    let replaying = false;
    let replayPending = 0;
    installStatusOsc(term.parser, {
      reply: (text) => void client.input(text).catch(() => {}),
      replaying: () => replaying || replayPending > 0,
      onProgramStatus: (r) => handlers.current.onProgramStatus?.(r),
      onProgress: (p) => handlers.current.onProgress?.(p),
    });
    // A program may write the clipboard (OSC 52) when the setting allows it; a read request is always refused.
    term.parser.registerOscHandler(52, (data) => {
      if (!getTerminalSettings().osc52Clipboard) return true;
      const text = decodeOsc52Write(data);
      if (text !== null) void navigator.clipboard?.writeText(text).catch(() => {});
      return true;
    });

    // A hidden view has no size; fitting it would shrink the pty to nothing.
    const fitVisible = () => {
      if (el.clientWidth > 0 && el.clientHeight > 0) fit.fit();
    };
    fitVisible();

    // R1: with right-click paste on, a plain right click pastes and Shift+right-click opens the menu;
    // off, a right click opens the menu. Capture phase: xterm moves its textarea under the pointer.
    const onContextMenu = (e: MouseEvent) => {
      if (getTerminalSettings().rightClickPaste && !e.shiftKey) {
        e.preventDefault();
        // As before, the text goes straight to the pty; an image becomes its saved path.
        void pasteClipboard({
          readText: async () => (await navigator.clipboard?.readText()) ?? "",
          saveImage: () => handlers.current.api.clipboardImageSave(),
          pasteText: (text) => client.input(text),
          writeRaw: (data) => client.input(data),
          shell: () => shellKind.current,
          bracketedMode: () => term.modes.bracketedPasteMode,
          annotate: annotatePasted,
        }).then((result) => reportPasteRef.current(result), () => {});
        return;
      }
      const menu = handlers.current.onMenu;
      if (!menu) return;
      e.preventDefault();
      e.stopPropagation();
      menu({ x: e.clientX, y: e.clientY }, handle.current);
    };
    el.addEventListener("contextmenu", onContextMenu, true);
    // Focus follows the mouse when set, unless the find bar's input has the focus.
    const onMouseEnter = () => {
      if (!getTerminalSettings().focusFollowsMouse) return;
      if (typeof document !== "undefined" && document.activeElement?.closest?.(".terminal-find")) return;
      term.focus();
    };
    el.addEventListener("mouseenter", onMouseEnter);
    // Linux, when set: a middle click pastes the selection. The browser's own paste is stopped so it
    // does not paste a second time.
    const onMiddle = (e: MouseEvent) => {
      const text = middlePasteText({
        enabled: getTerminalSettings().middleClickPaste,
        platform: PLATFORM,
        button: e.button,
        tracking: term.modes.mouseTrackingMode !== "none",
        selection: term.getSelection(),
      });
      if (text === null) return;
      e.preventDefault();
      if (e.type === "mouseup") term.paste(text);
    };
    for (const type of ["mousedown", "mouseup", "auxclick"]) el.addEventListener(type, onMiddle as EventListener, true);
    // A change in Settings applies to this pane at once, with no restart.
    const applySettings = () => {
      const next = xtermOptions(getTerminalSettings(), mono, color, getCustomSchemes(), appIsLight());
      term.options.fontFamily = next.fontFamily;
      term.options.fontSize = next.fontSize;
      term.options.fontWeight = next.fontWeight;
      term.options.lineHeight = next.lineHeight;
      term.options.cursorStyle = next.cursorStyle;
      term.options.cursorBlink = next.cursorBlink;
      term.options.scrollback = next.scrollback;
      term.options.theme = next.theme;
      paint(next.theme.background);
      term.options.wordSeparator = next.wordSeparator;
      term.options.scrollSensitivity = next.scrollSensitivity;
      term.options.fastScrollSensitivity = next.fastScrollSensitivity;
      term.options.minimumContrastRatio = next.minimumContrastRatio;
      term.options.fontWeightBold = next.fontWeightBold;
      term.options.scrollOnUserInput = next.scrollOnUserInput;
      term.options.allowTransparency = next.allowTransparency;
      applyInset();
      applyOptionMeta();
      renderer.set(getTerminalSettings().gpu);
      fitVisible();
      // A font that has not loaded yet measures wrong; measure again when it has.
      if (typeof document !== "undefined") void document.fonts?.ready.then(() => alive && fitVisible());
    };
    const offSettingsStore = subscribeTerminalSettings(applySettings);
    // An import or a removal changes which scheme an id means.
    const offSchemes = subscribeCustomSchemes(applySettings);
    const offSettings = () => {
      offSettingsStore();
      offSchemes();
    };

    // The app theme switching between light and dark: read the variables again for this pane.
    const offTheme = followAppTheme(el, (token, light) => {
      const next = xtermOptions(getTerminalSettings(), mono, token, getCustomSchemes(), light);
      term.options.theme = next.theme;
      paint(next.theme.background);
    });

    const owned = !props.client;
    const client = props.client ?? new PtyClient(props.api, props.id);
    clientRef.current = client;
    let alive = true;
    term.onData((text) => {
      handlers.current.onInput?.(text);
      void client.input(text).catch(() => {});
    });
    term.onTitleChange((title) => handlers.current.onTitle?.(title));
    term.onBell(() => {
      bell.ring(getTerminalSettings().bell);
      handlers.current.onBell?.();
    });
    term.onResize(({ cols, rows }) => void client.resize(cols, rows).catch(() => {}));
    // A mount undone in the same tick (StrictMode in dev) starts nothing, so a shared client
    // is started once, by the mount that stays.
    void Promise.resolve().then(() => {
      if (!alive) return;
      replaying = client.spawned;
      client.start(props.cwd, props.profile, term.cols, term.rows, (bytes, rendered) => {
        handlers.current.onOutput?.(bytes.length);
        if (replaying) {
          replayPending++;
          term.write(bytes, () => {
            replayPending--;
            rendered();
          });
        } else term.write(bytes, rendered);
      }, props.account ?? null, { truncated: t("ptyd.truncated") }).then(
        (info) => {
          replaying = false;
          if (!alive) return;
          isAgent.current = info.agent;
          // Limit: quoting follows the program the pane started, not a shell run inside it (pwsh in a
          // bash pane is quoted as bash). A WSL pane is quoted as posix; a Windows path is quoted but not converted to /mnt/c.
          shellKind.current = shellKindFor(info.program, info.agent, PLATFORM === "win");
          handlers.current.onStarted(info);
          term.focus();
        },
        (e: unknown) => {
          replaying = false;
          return alive && handlers.current.onError(toApiError(e));
        },
      );
    });
    const observer = new ResizeObserver(fitVisible);
    observer.observe(el);
    // Files dropped from the OS land here as paths; the shell's drop listener finds this pane by its host.
    const offDrop = registerDropTarget(el, {
      write: (data) => client.input(data),
      ready: () => client.spawned,
      focus: () => term.focus(),
      shell: () => shellKind.current,
      bracketed: () => term.modes.bracketedPasteMode,
    });

    return () => {
      alive = false;
      offDrop();
      offSettings();
      offTheme();
      offLayout();
      exitGone = true;
      offExit?.();
      modes.dispose();
      el.removeEventListener("focusout", clearOptionSides);
      renderer.dispose();
      bell.dispose();
      el.removeEventListener("contextmenu", onContextMenu, true);
      el.removeEventListener("mouseenter", onMouseEnter);
      for (const type of ["mousedown", "mouseup", "auxclick"]) el.removeEventListener(type, onMiddle as EventListener, true);
      observer.disconnect();
      setTip(null);
      if (owned) void client.dispose();
      search.current = null;
      xterm.current = null;
      if (clientRef.current === client) clientRef.current = null;
      term.dispose();
    };
  }, [props.api, props.id, props.client, props.cwd, props.profile, props.account]);

  return (
    <div className="terminal-pane">
      {find.open && search.current && (
        <TerminalFind
          search={search.current}
          initial={find.initial}
          focusSeq={find.seq}
          onQuery={(q) => void (lastQuery.current = q)}
          onClose={() => {
            setFind((f) => ({ ...f, open: false }));
            xterm.current?.focus();
          }}
        />
      )}
      <div ref={host} className="terminal-host" />
      {tip !== null && (
        <div className="x-tooltip term-link-tip" role="tooltip" data-open="">
          {tip}
        </div>
      )}
    </div>
  );
}
