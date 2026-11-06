import { Banner, Checkbox, Dialog, Disclosure, Field, Select, Spinner, Textarea } from "@xdev-asia/ui";
import { useEffect, useReducer, useRef, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type TaskPriority } from "@/api";
import { useI18n } from "@/i18n";
import { canAsk, decomposeReducer, finalDrafts, initialDecompose, MAX_GOAL, PRIORITIES } from "./decomposeModel";
import "@/styles/board.css";

type DecomposeApi = Pick<Api, "boardDecompose" | "boardCreateMany">;

export interface DecomposeDialogProps {
  api: DecomposeApi;
  repo: string;
  onClose(): void;
  /** The kept drafts are written. */
  onWritten(): void;
}

/** Splits a goal into task drafts with an agent; nothing is written before the review is confirmed. */
export function DecomposeDialog(props: DecomposeDialogProps): JSX.Element {
  const { api, repo } = props;
  const { t } = useI18n();
  const [s, dispatch] = useReducer(decomposeReducer, initialDecompose);
  const [writing, setWriting] = useState(false);
  const [writeFailed, setWriteFailed] = useState(false);
  const runs = useRef(0);
  const body = useRef<HTMLDivElement | null>(null);
  const first = useRef(true);

  // A step swaps the controls under the focus; move it to the first one of the new step.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const dialog = body.current?.closest(".dialog");
    dialog?.querySelector<HTMLElement>("textarea, input, select, button:not(:disabled)")?.focus();
  }, [s.step]);

  function ask(): void {
    if (!canAsk(s)) return;
    const run = ++runs.current;
    dispatch({ type: "ask", run });
    api.boardDecompose(repo, s.goal.trim()).then(
      (drafts) => dispatch({ type: "answered", run, drafts }),
      (e) => dispatch({ type: "failed", run, code: toApiError(e).code }),
    );
  }

  const drafts = finalDrafts(s.rows);

  async function write(): Promise<void> {
    if (drafts.length === 0 || writing) return;
    setWriting(true);
    setWriteFailed(false);
    try {
      await api.boardCreateMany(repo, drafts);
      props.onWritten();
    } catch {
      setWriteFailed(true);
    } finally {
      setWriting(false);
    }
  }

  const errorText =
    s.error === null
      ? null
      : s.error === "board_decompose_bad"
        ? t("board.decompose.bad")
        : s.error === "board_decompose_empty"
          ? t("board.decompose.none")
          : t(`error.${s.error}`);

  const priorities = PRIORITIES.map((p) => ({ value: p, label: t(`board.priority.${p}`) }));

  const review = s.step === "review";
  const running = s.step === "running";
  return (
    <Dialog
      modal
      size={review ? "wide" : "default"}
      title={t("board.decompose.title")}
      confirmLabel={review ? t("board.decompose.write", { count: drafts.length }) : t("board.decompose.run")}
      cancelLabel={review ? t("board.decompose.back") : t("dialog.cancel")}
      confirmDisabled={review ? drafts.length === 0 || writing : running || !canAsk(s)}
      onConfirm={review ? () => void write() : ask}
      onCancel={review ? () => dispatch({ type: "back" }) : running ? () => dispatch({ type: "cancel" }) : props.onClose}
    >
      <div className="board-decompose" ref={body}>
        {review ? (
          <>
            <h3 className="board-decompose-head">{t("board.decompose.review", { count: s.rows.length })}</h3>
            {writeFailed ? <Banner title={t("board.decompose.writeFailed")} /> : null}
            <ul className="board-decompose-rows">
              {s.rows.map((r) => (
                <li key={r.key} className="board-decompose-row">
                  <div className="board-decompose-main">
                    <Checkbox
                      aria-label={t("board.decompose.keep", { title: r.draft.title })}
                      checked={r.checked}
                      onChange={(e) => dispatch({ type: "check", key: r.key, checked: e.target.checked })}
                    />
                    <Field
                      className="board-decompose-title"
                      label={t("board.decompose.titleField")}
                      value={r.draft.title}
                      onChange={(e) => dispatch({ type: "edit", key: r.key, patch: { title: e.target.value } })}
                    />
                    <label className="ws-field board-decompose-priority">
                      {t("board.decompose.priority")}
                      <Select
                        value={r.draft.priority ?? "p2"}
                        options={priorities}
                        onChange={(e) => dispatch({ type: "edit", key: r.key, patch: { priority: e.target.value as TaskPriority } })}
                      />
                    </label>
                  </div>
                  <Disclosure title={t("board.decompose.details")} defaultExpanded={false}>
                    <Textarea
                      label={<span className="x-sr-only">{t("board.decompose.details")}</span>}
                      rows={3}
                      value={r.draft.body}
                      onChange={(e) => dispatch({ type: "edit", key: r.key, patch: { body: e.target.value } })}
                    />
                  </Disclosure>
                </li>
              ))}
            </ul>
          </>
        ) : running ? (
          <div className="board-decompose-running">
            <Spinner size="md" label={t("board.decompose.running")} />
            <span aria-hidden="true">{t("board.decompose.running")}</span>
          </div>
        ) : (
          <>
            {errorText ? <Banner title={errorText} /> : null}
            <Textarea
              label={t("board.decompose.goal")}
              hint={t("board.decompose.goal.hint")}
              rows={5}
              maxLength={MAX_GOAL}
              value={s.goal}
              onChange={(e) => dispatch({ type: "goal", goal: e.target.value })}
            />
          </>
        )}
      </div>
    </Dialog>
  );
}
