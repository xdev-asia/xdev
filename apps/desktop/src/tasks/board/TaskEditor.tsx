import { Banner, Button, Dialog, Field, Select, Textarea } from "@xdev-asia/ui";
import "@/styles/boardEditor.css";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type BoardTask, type TaskPriority, type TaskDraft, type TaskFull, type TaskStatus } from "@/api";
import { useProfiles } from "@/agents/profileStore";
import { useI18n } from "@/i18n";

type BoardApi = Pick<Api, "boardCreate" | "boardUpdate" | "boardGet">;

export const STATUSES: readonly TaskStatus[] = ["backlog", "todo", "in-progress", "in-review", "done"];
export const PRIORITIES: readonly TaskPriority[] = ["p0", "p1", "p2", "p3"];

/** The key of a status column label (`board.col.inProgress`). */
export const statusKey = (s: TaskStatus): string => `board.col.${s === "in-progress" ? "inProgress" : s === "in-review" ? "inReview" : s}`;

type Form = { title: string; status: TaskStatus; priority: TaskPriority; assignee: string; labels: string; body: string };

function formOf(task: TaskFull | undefined, draft: TaskDraft | undefined): Form {
  if (task) {
    const { task: x, body } = task;
    return { title: x.title, status: x.status, priority: x.priority, assignee: x.assignee ?? "", labels: x.labels.join(", "), body };
  }
  return {
    title: draft?.title ?? "",
    status: draft?.status ?? "backlog",
    priority: draft?.priority ?? "p2",
    assignee: draft?.assignee ?? "",
    labels: (draft?.labels ?? []).join(", "),
    body: draft?.body ?? "",
  };
}

/** The labels typed as one comma separated line. */
export const parseLabels = (text: string): string[] => text.split(",").map((l) => l.trim()).filter(Boolean);

/**
 * Creates a task (`draft`, or blank) or edits one (`task`); an edit can also be deleted. An edit sends the `updated` it read, so a
 * file changed on disk since then shows the conflict banner instead of being overwritten.
 */
export function TaskEditor(props: {
  api: BoardApi;
  repo: string;
  open: boolean;
  task?: TaskFull;
  draft?: TaskDraft;
  onClose(): void;
  onSaved(task: BoardTask): void;
  /** Shown for an existing task only. The caller hides it and offers Undo. */
  onDelete?(task: TaskFull): void;
}): JSX.Element | null {
  const { api, repo, open } = props;
  const { t } = useI18n();
  const profiles = useProfiles();
  // The task as last read: Reload replaces it.
  const [base, setBase] = useState<TaskFull | undefined>(props.task);
  const [form, setForm] = useState<Form>(() => formOf(props.task, props.draft));
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needTitle, setNeedTitle] = useState(false);

  useEffect(() => {
    if (!open) return;
    setBase(props.task);
    setForm(formOf(props.task, props.draft));
    setBusy(false);
    setConflict(false);
    setError(null);
    setNeedTitle(false);
    // Opening again starts from the props of that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const set = <K extends keyof Form>(key: K, value: Form[K]): void => setForm((f) => ({ ...f, [key]: value }));

  const agents = (profiles.view?.profiles ?? []).filter((p) => p.profile.enabled && p.installed).map((p) => ({ value: p.profile.id, label: p.profile.name }));
  // An agent no longer listed stays selectable, so saving does not drop it.
  if (form.assignee && !agents.some((a) => a.value === form.assignee)) agents.push({ value: form.assignee, label: form.assignee });
  const assigneeOptions = [{ value: "", label: t("board.field.assignee.none") }, ...agents];

  async function save(): Promise<void> {
    if (busy) return;
    const title = form.title.trim();
    if (!title) {
      setNeedTitle(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const labels = parseLabels(form.labels);
      const saved = base
        ? await api.boardUpdate(
            repo,
            base.task.id,
            { title, status: form.status, priority: form.priority, assignee: form.assignee || null, labels, body: form.body },
            base.task.updated,
          )
        : await api.boardCreate(repo, { title, status: form.status, priority: form.priority, assignee: form.assignee || undefined, labels, body: form.body });
      props.onSaved(saved);
    } catch (e) {
      const code = toApiError(e).code;
      if (code === "board_conflict") setConflict(true);
      else setError(code);
    } finally {
      setBusy(false);
    }
  }

  async function reload(): Promise<void> {
    if (!base) return;
    try {
      const fresh = await api.boardGet(repo, base.task.id);
      setBase(fresh);
      setForm(formOf(fresh, undefined));
      setConflict(false);
      setError(null);
    } catch (e) {
      setError(toApiError(e).code);
    }
  }

  return (
    <Dialog
      modal
      title={base ? t("board.edit.title") : t("board.create.title")}
      confirmLabel={t("board.save")}
      cancelLabel={t("dialog.cancel")}
      confirmDisabled={busy || conflict}
      onConfirm={() => void save()}
      onCancel={props.onClose}
    >
      <form
        className="board-editor"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {conflict ? (
          <Banner
            title={t("board.err.conflict")}
            action={
              <Button variant="secondary" type="button" onClick={() => void reload()}>
                {t("board.err.reload")}
              </Button>
            }
          />
        ) : null}
        {error ? (
          <p className="board-editor-error" role="alert">
            {t(`error.${error}`)}
          </p>
        ) : null}
        <Field
          name="title"
          label={t("board.field.title")}
          value={form.title}
          error={needTitle && !form.title.trim() ? t("board.field.title.required") : undefined}
          onChange={(e) => {
            set("title", e.target.value);
            setNeedTitle(false);
          }}
        />
        <div className="board-editor-row">
          <label className="ws-field">
            {t("board.field.status")}
            <Select name="status" value={form.status} onChange={(e) => set("status", e.target.value as TaskStatus)} options={STATUSES.map((s) => ({ value: s, label: t(statusKey(s)) }))} />
          </label>
          <label className="ws-field">
            {t("board.field.priority")}
            <Select name="priority" value={form.priority} onChange={(e) => set("priority", e.target.value as TaskPriority)} options={PRIORITIES.map((p) => ({ value: p, label: t(`board.priority.${p}`) }))} />
          </label>
          <label className="ws-field">
            {t("board.field.assignee")}
            <Select name="assignee" value={form.assignee} onChange={(e) => set("assignee", e.target.value)} options={assigneeOptions} />
          </label>
        </div>
        <Field name="labels" label={t("board.field.labels")} hint={t("board.field.labels.hint")} value={form.labels} onChange={(e) => set("labels", e.target.value)} />
        <Textarea name="body" label={t("board.field.body")} rows={8} value={form.body} onChange={(e) => set("body", e.target.value)} />
        {base && props.onDelete ? (
          <div className="board-editor-actions">
            <Button type="button" variant="secondary" icon="trash" data-act="delete" disabled={busy} onClick={() => props.onDelete?.(base)}>
              {t("board.delete")}
            </Button>
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}
