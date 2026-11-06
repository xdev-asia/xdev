import { useEffect, useReducer, useRef, useState } from "react";
import type { JSX } from "react";
import { Button, Dialog } from "@xdev-asia/ui";
import { toApiError, type Api, type FileVersion } from "@/api";
import type { Problem } from "@/changes/useChanges";
import { ProblemNote } from "@/components/ChangesPanel";
import { DiffView } from "@/components/DiffView";
import { useI18n } from "@/i18n";
import { canRestore, flow, START } from "./versionsModel";

export const when = (at: number) => new Date(at).toLocaleString();

/**
 * The versions an agent wrote of one file. Picking one shows what restoring it would change:
 * the version against the file as it is now. Restoring asks first.
 */
export function VersionsDialog(props: { api: Api; worktree: string; path: string; onClose(): void; onRestored(path: string): void }): JSX.Element {
  const { api, worktree, path, onClose, onRestored } = props;
  const { t } = useI18n();
  const [versions, setVersions] = useState<FileVersion[] | null>(null);
  const [state, dispatch] = useReducer(flow, START);
  const { picked, confirming } = state;
  const [text, setText] = useState<string | null>(null);
  const [current, setCurrent] = useState<string>("");
  const [problem, setProblem] = useState<Problem | null>(null);
  const [done, setDone] = useState("");
  const region = useRef<HTMLDivElement>(null);
  // Restore is off once the file is the version, so focus moves to the diff instead of being lost with the button.
  useEffect(() => {
    if (done) region.current?.focus();
  }, [done]);

  useEffect(() => {
    let live = true;
    api.attributionVersions(worktree, path).then(
      (list) => live && setVersions(list),
      (e) => live && (setVersions([]), setProblem(toApiError(e))),
    );
    return () => {
      live = false;
    };
  }, [api, worktree, path]);

  useEffect(() => {
    if (!picked) return;
    let live = true;
    setText(null);
    setProblem(null);
    Promise.all([api.attributionVersionRead(worktree, path, picked.id), api.fileRead(worktree, path).then((f) => f.text ?? "", () => "")]).then(
      ([version, now]) => {
        if (!live) return;
        setText(version);
        setCurrent(now);
      },
      (e) => live && setProblem(toApiError(e)),
    );
    return () => {
      live = false;
    };
  }, [api, worktree, path, picked]);

  async function restore(): Promise<void> {
    if (!picked) return;
    dispatch({ type: "restored" });
    try {
      await api.attributionRestore(worktree, path, picked.id);
      setDone(t("review.attr.restored", { path }));
      onRestored(path);
      // The file is the version now.
      setCurrent(text ?? "");
    } catch (e) {
      setProblem(toApiError(e));
    }
  }

  const label = (v: FileVersion) => `${v.agent ?? t("review.attr.unknown")} · ${when(v.at)}`;
  return (
    <>
      <Dialog modal size="wide" title={t("review.attr.versions.title", { path })} confirmLabel={t("review.attr.close")} cancelLabel={null} onConfirm={onClose} onCancel={onClose} body="plain">
        <div className="attr-versions">
          {versions === null && <p className="ws-empty">{t("review.loading")}</p>}
          {versions?.length === 0 && <p className="ws-empty">{t("review.attr.versions.none")}</p>}
          {versions && versions.length > 0 && (
            <ul className="attr-version-list" aria-label={t("review.attr.versions.list")}>
              {versions.map((v) => (
                <li key={v.id}>
                  <button type="button" className="attr-version" aria-pressed={picked?.id === v.id} onClick={() => dispatch({ type: "pick", version: v })}>
                    <span>{label(v)}</span>
                    <span className="attr-version-size ws-mono">{t("review.attr.version.size", { count: v.size })}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {problem && <ProblemNote problem={problem} />}
          <p className="attr-sr" role="status">
            {done}
          </p>
          {picked && text !== null && (
            <div className="attr-diff" role="region" aria-label={t("review.attr.diffLabel")} tabIndex={-1} ref={region}>
              <p className="attr-diff-head">{t("review.attr.diffHead", { version: label(picked) })}</p>
              <DiffView base={current} current={text} />
              <Button variant="secondary" disabled={!canRestore(state, current, text)} onClick={() => dispatch({ type: "ask" })}>
                {t("review.attr.restore")}
              </Button>
            </div>
          )}
        </div>
      </Dialog>
      {confirming && picked && <RestoreConfirm path={path} time={when(picked.at)} onConfirm={() => void restore()} onCancel={() => dispatch({ type: "cancel" })} />}
    </>
  );
}

/** The question before a restore overwrites the file. */
export function RestoreConfirm(props: { path: string; time: string; onConfirm(): void; onCancel(): void }): JSX.Element {
  const { t } = useI18n();
  return (
    <Dialog modal alert title={t("review.attr.restore.title", { path: props.path })} confirmLabel={t("review.attr.restore.confirm")} cancelLabel={t("review.attr.cancel")} onConfirm={props.onConfirm} onCancel={props.onCancel}>
      {t("review.attr.restore.body", { time: props.time })}
    </Dialog>
  );
}
