import { Button, Field, IconButton, ListRow, Segmented, Textarea } from "@xdev-asia/ui";
import { useState } from "react";
import type { FormEvent, JSX } from "react";
import { toApiError, type Api, type PromptTemplate, type TemplateMode } from "@/api";
import { useI18n } from "@/i18n";
import { newTemplateId } from "./mentions";

type Editing = { id: string | null; name: string; body: string; mode: TemplateMode };

/** The composer's template list: create, edit and delete named prompt texts. */
export function TemplatesManager(props: { api: Api; templates: PromptTemplate[]; onChange(list: PromptTemplate[]): void; onBack(): void }): JSX.Element {
  const { api, templates } = props;
  const { t } = useI18n();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!editing || editing.name.trim() === "") return;
    setBusy(true);
    try {
      const list = await api.promptTemplatesPut({ id: editing.id ?? newTemplateId(), name: editing.name, body: editing.body, mode: editing.mode });
      props.onChange(list);
      setEditing(null);
      setNote(t("composer.templates.saved"));
    } catch (err) {
      setNote(t(toApiError(err).code === "too_large" ? "composer.templates.tooLarge" : "composer.templates.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(tpl: PromptTemplate) {
    try {
      props.onChange(await api.promptTemplatesDelete(tpl.id));
      setNote(t("composer.templates.deleted", { name: tpl.name }));
    } catch {
      setNote(t("composer.templates.saveFailed"));
    }
  }

  const modes = [
    { value: "insert", label: t("composer.templates.mode.insert") },
    { value: "append", label: t("composer.templates.mode.append") },
  ];

  if (editing) {
    return (
      <form className="composer-templates" onSubmit={(e) => void save(e)}>
        <Field
          label={t("composer.templates.name")}
          value={editing.name}
          maxLength={80}
          required
          autoFocus
          onChange={(e) => setEditing({ ...editing, name: e.target.value })}
        />
        <Textarea mono rows={5} label={t("composer.templates.body")} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
        <div className="ws-field">
          <span id="composer-template-mode">{t("composer.templates.mode")}</span>
          <Segmented label={t("composer.templates.mode")} options={modes} value={editing.mode} onChange={(v) => setEditing({ ...editing, mode: v as TemplateMode })} />
          <small>{t(editing.mode === "insert" ? "composer.templates.mode.insertHint" : "composer.templates.mode.appendHint")}</small>
        </div>
        <div className="composer-actions">
          <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
            {t("dialog.cancel")}
          </Button>
          <Button variant="primary" type="submit" disabled={busy || editing.name.trim() === ""}>
            {t("composer.templates.save")}
          </Button>
        </div>
        <p className="composer-status" role="status">
          {note}
        </p>
      </form>
    );
  }

  return (
    <div className="composer-templates">
      {templates.length === 0 ? (
        <p className="composer-empty">{t("composer.templates.empty")}</p>
      ) : (
        <ul className="composer-template-list" aria-label={t("composer.templates.title")}>
          {templates.map((tpl) => (
            <ListRow
              key={tpl.id}
              as="li"
              title={tpl.name}
              meta={t(tpl.mode === "insert" ? "composer.templates.mode.insert" : "composer.templates.mode.append")}
              trailing={
                <>
                  <IconButton icon="edit" label={t("composer.templates.edit", { name: tpl.name })} onClick={() => setEditing({ id: tpl.id, name: tpl.name, body: tpl.body, mode: tpl.mode })} />
                  <IconButton icon="trash" label={t("composer.templates.delete", { name: tpl.name })} onClick={() => void remove(tpl)} />
                </>
              }
            />
          ))}
        </ul>
      )}
      <div className="composer-actions">
        <Button type="button" variant="secondary" onClick={props.onBack}>
          {t("composer.templates.back")}
        </Button>
        <Button type="button" variant="secondary" icon="plus" disabled={templates.length >= 200} onClick={() => setEditing({ id: null, name: "", body: "", mode: "insert" })}>
          {t("composer.templates.new")}
        </Button>
      </div>
      <p className="composer-status" role="status">
        {note}
      </p>
    </div>
  );
}
