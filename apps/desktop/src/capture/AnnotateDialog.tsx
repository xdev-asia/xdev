import { Button, Dialog, Field, IconButton, Kbd, Segmented, SwatchGroup, Toolbar, type SwatchTone } from "@xdev-asia/ui";
import { useEffect, useReducer, useRef, useState } from "react";
import type { JSX, KeyboardEvent, PointerEvent } from "react";
import { useI18n } from "@/i18n";
import { IS_MAC } from "@/platform";
import { pushToast } from "@/workspace/toastStore";
import { COLOR_KEYS, DEFAULT_TEXT_SIZE, TOOLS, initialState, reducer, type ColorKey, type Shape, type Tool } from "./annotModel";
import { exportPng } from "./exportPng";
import { draw, resolveColors, type Colors, type Drawable } from "./render";

/** Each annotation colour as the library tone that draws it. */
const SWATCH_TONE = { danger: "danger", warning: "warning", accent: "accent", fg: "neutral" } as const satisfies Record<ColorKey, SwatchTone>;

export interface AnnotateDialogProps {
  image: Drawable;
  /** Sends the image with its shapes; the dialog closes from the host when it worked. */
  onSend(shapes: readonly Shape[], colors: Colors): Promise<void>;
  onDiscard(): void;
}

const undoHint = IS_MAC ? "⌘Z" : "Ctrl+Z";
const redoHint = IS_MAC ? "⇧⌘Z" : "Ctrl+Shift+Z";

/** A note about as tall as 1.7% of the image, never under 16 px. */
const textSizeFor = (width: number) => Math.max(16, Math.round((22 * width) / 1280)) || DEFAULT_TEXT_SIZE;

/** Draws on a screenshot (arrow, box, text, blur) and sends, copies or discards it. */
export function AnnotateDialog({ image, onSend, onDiscard }: AnnotateDialogProps): JSX.Element {
  const { t } = useI18n();
  const [state, dispatch] = useReducer(reducer, initialState);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const { shapes, draft, tool, color, editingText } = state;

  const colors = (): Colors => resolveColors(canvas.current ?? document.documentElement);

  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    draw(ctx, image, draft && draft.tool !== "text" ? [...shapes, draft] : shapes, colors());
  }, [image, shapes, draft]);

  /** A pointer position in image pixels. */
  const at = (e: PointerEvent<HTMLCanvasElement>) => {
    const el = canvas.current!;
    const rect = el.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) * el.width) / (rect.width || 1), y: ((e.clientY - rect.top) * el.height) / (rect.height || 1) };
  };

  const requestDiscard = () => (shapes.length > 0 ? setConfirming(true) : onDiscard());

  const send = async () => {
    setBusy(true);
    try {
      await onSend(shapes, colors());
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      const bytes = await exportPng(image, shapes, colors());
      await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([bytes as BlobPart], { type: "image/png" }) })]);
      pushToast({ text: t("capture.copied") });
    } catch {
      pushToast({ text: t("capture.copyFailed") });
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).tagName === "INPUT" && (e.target as HTMLInputElement).type === "text") return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      dispatch({ type: e.shiftKey ? "redo" : "undo" });
    } else if (e.key === "Delete" || e.key === "Backspace") {
      dispatch({ type: "deleteSelected" });
    } else if (!e.metaKey && !e.ctrlKey && !e.altKey && /^[1-4]$/.test(e.key)) {
      dispatch({ type: "setTool", tool: TOOLS[Number(e.key) - 1] });
    }
  };

  const el = canvas.current;
  const scale = el && el.width ? el.clientWidth / el.width : 1;
  const note = editingText && draft?.tool === "text" ? draft : null;

  return (
    <>
      <Dialog
        modal
        size="wide"
        title={t("capture.title")}
        confirmLabel={t("capture.send")}
        cancelLabel={t("capture.discard")}
        confirmDisabled={busy}
        onConfirm={() => void send()}
        onCancel={requestDiscard}
      >
        {/* The keys act for everything inside the dialog; the controls have their own roles. */}
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
        <div className="annotate" onKeyDown={onKeyDown}>
          <div className="annotate-bar">
            <Toolbar
              label={t("capture.tools")}
              actions={
                <>
                  <Segmented
                    label={t("capture.tools")}
                    value={tool}
                    options={TOOLS.map((value) => ({ value, label: t(`capture.tool.${value}`) }))}
                    onChange={(value) => dispatch({ type: "setTool", tool: value as Tool })}
                  />
                  <span className="annotate-undo">
                    <IconButton icon="undo" label={t("capture.undo")} disabled={state.undo.length === 0} onClick={() => dispatch({ type: "undo" })} />
                    <Kbd>{undoHint}</Kbd>
                  </span>
                  <span className="annotate-undo">
                    <IconButton icon="redo" label={t("capture.redo")} disabled={state.redo.length === 0} onClick={() => dispatch({ type: "redo" })} />
                    <Kbd>{redoHint}</Kbd>
                  </span>
                </>
              }
            />
            <SwatchGroup
              size="sm"
              aria-label={t("capture.color")}
              value={color}
              onChange={(value) => dispatch({ type: "setColor", color: value as ColorKey })}
              options={COLOR_KEYS.map((value) => ({ value, label: t(`capture.color.${value}`), tone: SWATCH_TONE[value] }))}
            />
          </div>
          <div className="annotate-stage">
            <canvas
              ref={canvas}
              className="annotate-canvas"
              width={image.width}
              height={image.height}
              role="img"
              aria-label={t("capture.canvas")}
              // The click must not move focus off the note field it just opened.
              onMouseDown={(e) => e.preventDefault()}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.currentTarget.setPointerCapture?.(e.pointerId);
                dispatch({ type: "pointerDown", ...at(e), size: textSizeFor(image.width) });
              }}
              onPointerMove={(e) => dispatch({ type: "pointerMove", ...at(e) })}
              onPointerUp={(e) => dispatch({ type: "pointerUp", ...at(e) })}
              onPointerCancel={() => dispatch({ type: "setTool", tool })}
            />
            {note && (
              <div
                className="annotate-note"
                style={{ left: Math.min(note.x * scale, Math.max(0, (el?.clientWidth ?? 0) - 200)), top: note.y * scale }}
                // The field takes its own keys: Enter commits, Escape cancels, and neither reaches the dialog.
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    dispatch({ type: "commitText", text: (e.target as HTMLInputElement).value });
                  } else if (e.key === "Escape") {
                    e.stopPropagation();
                    dispatch({ type: "cancelText" });
                  }
                }}
              >
                <Field
                  key={note.id}
                  label={t("capture.text.placeholder")}
                  hideLabel
                  placeholder={t("capture.text.placeholder")}
                  autoFocus
                  autoComplete="off"
                  onBlur={(e) => dispatch({ type: "commitText", text: e.currentTarget.value })}
                />
              </div>
            )}
          </div>
          <div className="annotate-extra">
            <Button variant="secondary" onClick={() => void copy()}>
              {t("capture.copy")}
            </Button>
          </div>
        </div>
      </Dialog>
      {confirming && (
        <Dialog
          modal
          alert
          title={t("capture.discard.title")}
          confirmLabel={t("capture.discard.confirm")}
          cancelLabel={t("capture.discard.keep")}
          onConfirm={onDiscard}
          onCancel={() => setConfirming(false)}
        >
          {t("capture.discard.body")}
        </Dialog>
      )}
    </>
  );
}
