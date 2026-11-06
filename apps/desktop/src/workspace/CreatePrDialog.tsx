import { Button } from "@xdev-asia/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError, type PrDraft, type PrView, type ReviewHost } from "@/api";
import { isRecipeProblem } from "@/components/ChangesPanel";
import { glabReasonText } from "@/issues/glabReason";
import { useI18n } from "@/i18n";
import { mrAsPr } from "./ship";

// The strings that differ between a pull request and a merge request.
const PR_WORDS = { title: "ship.pr.title", base: "ship.pr.base", draft: "ship.pr.draft", create: "ship.pr.create", creating: "ship.pr.creating" } as const;
const MR_WORDS = { title: "ship.mr.title", base: "ship.mr.target", draft: "ship.mr.draft", create: "ship.mr.create", creating: "ship.mr.creating" } as const;

// Mounted only while open, so every opening starts from the given fields.
export function CreatePrDialog(props: {
  api: Api;
  worktree: string;
  initial: PrDraft;
  onCreated(pr: PrView): void;
  onClose(): void;
  // Settings → Git. Without `ai` the agent button is hidden.
  ai?: boolean;
  // Opens Settings → Git, where the recipe's agent is chosen; offered when the agent is the problem.
  onOpenGitSettings?(): void;
  // Runs the agent once on open.
  generateOnOpen?: boolean;
  // Opens the new pull request in the browser.
  openAfterCreate?: boolean;
  // Where the request is made; "gitlab" creates a merge request through glab. Default "github".
  host?: ReviewHost;
}): JSX.Element {
  const { api, worktree } = props;
  const ai = props.ai ?? true;
  const gitlab = props.host === "gitlab";
  const words = gitlab ? MR_WORDS : PR_WORDS;
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [base, setBase] = useState(props.initial.base);
  const [title, setTitle] = useState(props.initial.title);
  const [body, setBody] = useState(props.initial.body);
  const [draft, setDraft] = useState(props.initial.draft);
  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    const d = dialog.current;
    if (d && typeof d.showModal === "function" && !d.open) d.showModal();
    if (ai && props.generateOnOpen) void agent();
    // Only on open: the dialog is mounted once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function agent(): Promise<void> {
    setDrafting(true);
    setError(null);
    try {
      const drafted = await api.worktreeDraftPr(worktree);
      setTitle(drafted.title);
      setBody(drafted.body);
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setDrafting(false);
    }
  }

  async function create(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const fields = { base: base.trim(), title: title.trim(), body, draft };
      let created: PrView;
      if (gitlab) {
        const mr = await api.worktreeMrCreate(worktree, fields);
        // The merge request exists either way; a browser that will not open is not an error here.
        if (props.openAfterCreate) void api.openUrl(mr.url).catch(() => undefined);
        created = mrAsPr(mr);
      } else {
        created = await api.worktreePrCreate(worktree, fields);
        // The pull request exists either way; a browser that will not open is not an error here.
        if (props.openAfterCreate) void api.worktreePrOpen(worktree, false).catch(() => undefined);
      }
      props.onCreated(created);
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setBusy(false);
    }
  }

  const blocked = busy || drafting || title.trim() === "";

  return (
    <dialog
      ref={dialog}
      className="dialog ws-dialog"
      aria-labelledby="ws-pr-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) props.onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!blocked) void create();
        }}
      >
        <h2 id="ws-pr-title" className="dialog-title">
          {t(words.title)}
        </h2>
        <div className="ws-fields">
          <label className="ws-field">
            <span>{t(words.base)}</span>
            <input type="text" className="ws-mono" value={base} spellCheck={false} disabled={busy} onChange={(e) => setBase(e.target.value)} />
          </label>
          <label className="ws-field">
            <span>{t("ship.pr.titleField")}</span>
            <input type="text" value={title} autoFocus disabled={busy} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="ws-field">
            <span>{t("ship.pr.body")}</span>
            <textarea rows={6} value={body} disabled={busy} onChange={(e) => setBody(e.target.value)} />
          </label>
          <label className="ws-amend">
            <input type="checkbox" checked={draft} disabled={busy} onChange={() => setDraft((d) => !d)} />
            {t(words.draft)}
          </label>
        </div>
        {error && (
          <p className="error-text" role="alert">
            {gitlab ? glabReasonText(error, t) : t(`error.${error.code}`)}
            {["git", "push_rejected", "gh_failed", "draft_failed", "denied", "body_too_long"].includes(error.code) && error.detail ? ` ${error.detail}` : ""}
            {props.onOpenGitSettings && isRecipeProblem(error.code) && (
              <>
                {" "}
                <button type="button" className="ws-ship-link" data-open-settings="git" onClick={props.onOpenGitSettings}>
                  {t("recipes.openSettings")}
                </button>
              </>
            )}
          </p>
        )}
        <div className="dialog-actions">
          {ai && (
            <button type="button" className="btn-secondary" disabled={busy || drafting} onClick={() => void agent()}>
              {drafting ? t("ship.pr.agentBusy") : t("ship.pr.agent")}
            </button>
          )}
          <button type="button" className="btn-secondary" disabled={busy} onClick={props.onClose}>
            {t("dialog.cancel")}
          </button>
          <Button type="submit" disabled={blocked}>
            {busy ? t(words.creating) : t(words.create)}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
