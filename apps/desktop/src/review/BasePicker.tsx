import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { Api, ReviewBase, ReviewBranch } from "@/api";
import { useI18n } from "@/i18n";

/**
 * What the review compares against: where the worktree started, the repo's base branch, any
 * other branch, or a commit or ref typed in. `onPick(null)` means the start.
 */
export function BasePicker(props: { api: Api; worktree: string; base: ReviewBase; baseRef: string; onPick(base: string | null): void }): JSX.Element {
  const { api, worktree, base, baseRef, onPick } = props;
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<ReviewBranch[] | null>(null);
  const [typed, setTyped] = useState("");

  // The branch list costs a git call, so it is read when the picker first opens.
  useEffect(() => {
    if (!open || branches) return;
    let alive = true;
    api.worktreeBranches(worktree).then(
      (list) => alive && setBranches(list),
      () => alive && setBranches([]),
    );
    return () => {
      alive = false;
    };
  }, [api, worktree, open, branches]);

  const label = base.kind === "start" ? t("review.base.start") : (base.name ?? base.id.slice(0, 8));
  const choose = (value: string | null) => {
    setOpen(false);
    setTyped("");
    onPick(value);
  };
  const others = (branches ?? []).filter((b) => b.name !== baseRef);

  return (
    <div className="rv-base">
      <span className="rv-base-label">{t("review.base.label")}</span>
      <button type="button" className="rv-base-button ws-mono" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        {label}
      </button>
      {open && (
        <div className="rv-base-menu" role="listbox" aria-label={t("review.base.label")}>
          <button type="button" role="option" aria-selected={base.kind === "start"} onClick={() => choose(null)}>
            {t("review.base.start")}
          </button>
          <button type="button" role="option" aria-selected={base.name === baseRef} className="ws-mono" onClick={() => choose(baseRef)}>
            {baseRef}
          </button>
          {branches === null && <p className="ws-empty">{t("review.loading")}</p>}
          {others.map((b) => (
            <button key={b.name} type="button" role="option" aria-selected={base.name === b.name} className="ws-mono" onClick={() => choose(b.name)}>
              {b.name}
            </button>
          ))}
          <form
            className="rv-base-free"
            onSubmit={(e) => {
              e.preventDefault();
              if (typed.trim()) choose(typed.trim());
            }}
          >
            <input
              className="ws-mono"
              value={typed}
              placeholder={t("review.base.type")}
              aria-label={t("review.base.type")}
              onChange={(e) => setTyped(e.target.value)}
            />
          </form>
        </div>
      )}
    </div>
  );
}
