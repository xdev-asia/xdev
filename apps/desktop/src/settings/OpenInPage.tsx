import { Badge, Button, Select } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type ApiError, type OpenAs, type OpenInApp, type OpenInView } from "@/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useI18n } from "@/i18n";
import { isPresetAdded, OPEN_IN_PRESETS, presetEntry } from "./openInPresets";
import { SettingRow } from "./SettingRow";
import type { SettingsSectionProps } from "./sections";

/** At most this many apps; the same limit `open_in_settings_put` checks. */
export const MAX_APPS = 8;
/** `OpenInSettings::default()` in Rust: VS Code alone. */
export const DEFAULT_APPS: OpenInApp[] = [{ id: "vscode", label: "VS Code", command: "code", args: [] }];

type Field = "label" | "command" | "args";
interface Draft {
  /** The id of the app being edited; null for a new one. */
  id: string | null;
  label: string;
  command: string;
  /** One argument per line. */
  args: string;
}

/** Where an agent may open by default, in the order the page lists them. */
export const OPEN_AS_CHOICES: OpenAs[] = ["tab", "splitRight", "splitDown"];

/** What `open_in_settings` found, by command: the list's apps (matched to their id) and the presets (keyed by command). */
export function foundByCommand(view: Pick<OpenInView, "apps" | "found" | "presets">): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const p of view.presets) out[p.id] = p.found;
  for (const f of view.found) {
    const app = view.apps.find((a) => a.id === f.id);
    if (app) out[app.command.trim()] = f.found;
  }
  return out;
}

/** The first `app-N` id nobody uses. */
export function nextId(apps: OpenInApp[]): string {
  const used = new Set(apps.map((a) => a.id));
  for (let n = 1; ; n++) if (!used.has(`app-${n}`)) return `app-${n}`;
}

/** The list with item `from` moved to `to`, or the same list when that is out of range. */
export function move<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from === to) return list;
  const next = [...list];
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next;
}

const toArgs = (text: string): string[] =>
  text
    .split("\n")
    .map((a) => a.trim())
    .filter((a) => a !== "");

/**
 * Settings → Open In Apps: the programs the Open in menu starts. An app is a label, a program and a
 * fixed argument list (the folder is added last); there is no shell line. Every change is stored at once.
 */
export function OpenInPage(props: SettingsSectionProps): JSX.Element {
  const { api } = props;
  const { t } = useI18n();
  const [apps, setApps] = useState<OpenInApp[] | null>(null);
  // Command → program found on this computer; apps and presets alike. A command not listed is not known to be missing.
  const [found, setFound] = useState<Record<string, boolean>>({});
  const [openAs, setOpenAs] = useState<OpenAs>("tab");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<OpenInApp | null>(null);
  // `bad_arg` carries the field name in its detail; any other code shows as a line under the list.
  const [fieldError, setFieldError] = useState<Field | null>(null);
  const [error, setError] = useState<ApiError["code"]>();

  useEffect(() => {
    api.openInSettings().then(
      (s) => {
        setApps(s.apps);
        setFound(foundByCommand(s));
      },
      (e: unknown) => setError(toApiError(e).code),
    );
    api.agentsSettings().then((s) => setOpenAs(s.openAs), () => {});
  }, [api]);

  /** Stores `next`; true when it was accepted. */
  async function save(next: OpenInApp[]): Promise<boolean> {
    setError(undefined);
    setFieldError(null);
    try {
      const stored = await api.openInSettingsPut({ apps: next });
      setApps(stored.apps);
      props.onChanged();
      return true;
    } catch (e) {
      const err = toApiError(e);
      if (err.code === "bad_arg" && (err.detail === "label" || err.detail === "command" || err.detail === "args")) setFieldError(err.detail);
      else setError(err.code);
      return false;
    }
  }

  /** Stores the default place an agent opens; the rest of the Agents settings is kept. */
  async function saveOpenAs(next: OpenAs): Promise<void> {
    setError(undefined);
    try {
      const stored = await api.agentsSettingsPut({ ...(await api.agentsSettings()), openAs: next });
      setOpenAs(stored.openAs);
      props.onChanged();
    } catch (e) {
      setError(toApiError(e).code);
    }
  }

  async function commit(): Promise<void> {
    if (!draft || !apps) return;
    const app: OpenInApp = { id: draft.id ?? nextId(apps), label: draft.label.trim(), command: draft.command.trim(), args: toArgs(draft.args) };
    const next = draft.id === null ? [...apps, app] : apps.map((a) => (a.id === draft.id ? app : a));
    if (await save(next)) setDraft(null);
  }

  const header = (
    <header className="settings-head">
      <h3>{t("openIn.title")}</h3>
      <p>{t("openIn.intro")}</p>
    </header>
  );
  if (!apps) {
    return (
      <div className="settings-page">
        {header}
        {error && (
          <p className="error-text" role="alert">
            {t(`error.${error}`)}
          </p>
        )}
      </div>
    );
  }

  const field = (name: Field, rows?: number): JSX.Element => {
    const bad = fieldError === name;
    const errorId = `openin-${name}-error`;
    const common = {
      name,
      value: draft![name],
      spellCheck: false,
      "aria-invalid": bad || undefined,
      "aria-describedby": bad ? errorId : undefined,
      onChange: (e: { target: { value: string } }) => setDraft({ ...draft!, [name]: e.target.value }),
    };
    return (
      <label className="ws-field">
        <span>{t(`openIn.${name}`)}</span>
        {rows ? <textarea {...common} className="ws-mono" rows={rows} /> : <input {...common} className={name === "command" ? "ws-mono" : undefined} />}
        <span className="settings-hint">{t(`openIn.${name}.hint`)}</span>
        {bad && (
          <span id={errorId} className="settings-error" role="alert">
            {t("error.bad_arg")}
          </span>
        )}
      </label>
    );
  };

  return (
    <div className="settings-page">
      {header}
      <SettingRow id="openIn.apps" filter={props.filter}>
      <ul className="openin-list">
        {apps.map((app, i) => (
          <li key={app.id} className="settings-card openin-row" data-app={app.id}>
            <div className="settings-item-text">
              <strong>{app.label}</strong>
              <span className="settings-path ws-mono">{[app.command, ...app.args].join(" ")}</span>
              {found[app.command.trim()] === false && <span className="settings-hint" data-found="false">{t("openIn.missing.reason")}</span>}
            </div>
            <div className="settings-actions">
              {found[app.command.trim()] !== undefined && (
                <Badge status={found[app.command.trim()] ? "unchanged" : "changed"}>{t(found[app.command.trim()] ? "openIn.found" : "openIn.missing")}</Badge>
              )}
              <button type="button" className="btn-secondary" data-act="up" aria-label={t("openIn.moveUp", { name: app.label })} disabled={i === 0} onClick={() => void save(move(apps, i, i - 1))}>
                ↑
              </button>
              <button type="button" className="btn-secondary" data-act="down" aria-label={t("openIn.moveDown", { name: app.label })} disabled={i === apps.length - 1} onClick={() => void save(move(apps, i, i + 1))}>
                ↓
              </button>
              <button
                type="button"
                className="btn-secondary"
                data-act="edit"
                onClick={() => {
                  setFieldError(null);
                  setDraft({ id: app.id, label: app.label, command: app.command, args: app.args.join("\n") });
                }}
              >
                {t("openIn.edit")}
              </button>
              <button type="button" className="btn-secondary" data-act="delete" onClick={() => setDeleting(app)}>
                {t("openIn.delete")}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {apps.length === 0 && <p className="settings-empty">{t("openIn.empty")}</p>}
      {error && (
        <p className="error-text" role="alert">
          {t(`error.${error}`)}
        </p>
      )}
      {draft && (
        <form
          className="settings-card"
          onSubmit={(e) => {
            e.preventDefault();
            void commit();
          }}
        >
          <div className="ws-fields">
            {field("label")}
            {field("command")}
            {field("args", 3)}
          </div>
          <div className="settings-actions">
            <button type="button" className="btn-secondary" onClick={() => setDraft(null)}>
              {t("openIn.cancel")}
            </button>
            <Button type="submit">{t("openIn.save")}</Button>
          </div>
        </form>
      )}
      <div className="settings-actions settings-actions-start">
        <button
          type="button"
          className="btn-secondary"
          data-act="add"
          disabled={apps.length >= MAX_APPS || draft?.id === null}
          onClick={() => {
            setFieldError(null);
            setDraft({ id: null, label: "", command: "", args: "" });
          }}
        >
          {t("openIn.add")}
        </button>
        <button
          type="button"
          className="btn-secondary"
          data-act="reset"
          onClick={() => void save(structuredClone(DEFAULT_APPS)).then((ok) => ok && setDraft(null))}
        >
          {t("openIn.reset")}
        </button>
        {apps.length >= MAX_APPS && <span className="settings-hint">{t("openIn.limit", { count: MAX_APPS })}</span>}
      </div>
      </SettingRow>
      <section className="openin-presets" aria-label={t("openIn.openAs")} data-section="open-as">
        <h4>{t("openIn.openAs")}</h4>
        <p className="settings-hint">{t("openIn.openAs.hint")}</p>
        <label className="ws-field">
          <span>{t("openIn.openAs")}</span>
          <Select name="openAs" value={openAs} options={OPEN_AS_CHOICES.map((c) => ({ value: c, label: t(`openIn.openAs.${c}`) }))} onChange={(e) => void saveOpenAs(e.target.value as OpenAs)} />
        </label>
      </section>
      <section className="openin-presets" aria-label={t("openIn.presets")}>
        <h4>{t("openIn.presets")}</h4>
        <p className="settings-hint">{t("openIn.presets.hint")}</p>
        <ul className="openin-list">
          {OPEN_IN_PRESETS.map((preset) => {
            const added = isPresetAdded(apps, preset);
            const missing = found[preset.command] === false;
            return (
              <li key={preset.command} className="settings-card openin-row" data-preset={preset.command}>
                <div className="settings-item-text">
                  <strong>{preset.label}</strong>
                  <span className="settings-path ws-mono">{preset.command}</span>
                  {missing && !added && <span className="settings-hint" data-found="false">{t("openIn.missing.reason")}</span>}
                </div>
                <div className="settings-actions">
                  {added ? (
                    <Badge status="unchanged">{t("openIn.preset.added")}</Badge>
                  ) : (
                    <button
                      type="button"
                      className="btn-secondary"
                      data-act="add-preset"
                      aria-label={t("openIn.preset.addName", { name: preset.label })}
                      disabled={apps.length >= MAX_APPS || missing}
                      onClick={() => void save([...apps, presetEntry(apps, preset)])}
                    >
                      {t("openIn.preset.add")}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>
      {deleting && (
        <ConfirmDialog
          open
          title={t("openIn.delete.title", { name: deleting.label })}
          body={t("openIn.delete.body")}
          confirmLabel={t("openIn.delete")}
          onConfirm={() => {
            const gone = deleting;
            setDeleting(null);
            void save(apps.filter((a) => a.id !== gone.id));
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
