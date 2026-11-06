import { Button, Select } from "@xdev-asia/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type AppTheme, type OnNameTaken } from "@/api";
import { useI18n } from "@/i18n";
import { refreshAppThemes, setAppThemeSource } from "@/ui/appTheme";
import { SettingGroup, SettingRow } from "../SettingRow";
import type { SettingsFilter } from "../sections";
import { ThemeEditorPanel } from "./ThemeEditorPanel";

const IDS = ["appearance.colourTheme"];

/** The extensions the import dialog offers; `xdev-theme` keeps theme files apart from terminal scheme files. */
export const THEME_FILE_EXTENSIONS = ["json", "xdev-theme"];

/** The message key of an error from an import. */
export function importErrorKey(e: unknown): string {
  const code = toApiError(e).code;
  if (code === "theme_too_large") return "settings.appearance.colours.error.large";
  if (code === "theme_invalid" || code === "not_found") return "settings.appearance.colours.error.file";
  return "settings.appearance.colours.error.save";
}

function ClashDialog(props: { name: string | null; busy: boolean; onPick(onTaken: OnNameTaken): void; onCancel(): void }): JSX.Element {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const open = props.name !== null;
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className="dialog"
      aria-labelledby="theme-clash-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!props.busy) props.onCancel();
      }}
    >
      <h2 id="theme-clash-title" className="dialog-title">
        {t("settings.appearance.colours.clash.title")}
      </h2>
      <p className="dialog-body">{t("settings.appearance.colours.clash.body", { name: props.name ?? "" })}</p>
      <div className="dialog-actions">
        <Button type="button" variant="secondary" data-action="cancel" disabled={props.busy} onClick={props.onCancel}>
          {t("settings.appearance.colours.clash.cancel")}
        </Button>
        <Button type="button" variant="secondary" data-action="replace" disabled={props.busy} onClick={() => props.onPick("replace")}>
          {t("settings.appearance.colours.clash.replace")}
        </Button>
        <Button type="button" variant="secondary" data-action="keepBoth" disabled={props.busy} onClick={() => props.onPick("keepBoth")}>
          {t("settings.appearance.colours.clash.keepBoth")}
        </Button>
      </div>
    </dialog>
  );
}

/** Settings → Appearance → Theme colours: pick, create, edit, import, export and delete app themes. */
export function ThemeColours(props: {
  api: Api;
  filter?: SettingsFilter;
  /** The id of the active theme; empty is Default. */
  active: string;
  /** Makes `id` the active theme (empty: Default); resolves when the setting is stored and painted. */
  onSelect(id: string): Promise<void>;
}): JSX.Element {
  const { api, filter, active } = props;
  const { t } = useI18n();
  const [themes, setThemes] = useState<readonly AppTheme[]>([]);
  const [editing, setEditing] = useState<{ theme: AppTheme | null } | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [clash, setClash] = useState<{ path: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setAppThemeSource(api);
    let live = true;
    api.appThemes().then(
      (list) => live && setThemes(list),
      (e) => live && setError(t(importErrorKey(e))),
    );
    return () => {
      live = false;
    };
  }, [api]);

  const current = themes.find((x) => x.id === active) ?? null;
  const reload = async () => setThemes(await refreshAppThemes());
  const say = (message: string) => {
    setError("");
    setNote(message);
  };

  async function run(work: () => Promise<void>, fail: (e: unknown) => string): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } catch (e) {
      setNote("");
      setError(fail(e));
    } finally {
      setBusy(false);
    }
  }
  const failKey = (key: string) => () => t(key);

  const onSaved = async (saved: AppTheme) => {
    // The list first, so the selection finds the theme when it paints.
    await reload();
    await props.onSelect(saved.id);
    setEditing(null);
    say(t("settings.appearance.colours.saved", { name: saved.name }));
  };

  const doImport = (path: string, onTaken: OnNameTaken) =>
    run(async () => {
      try {
        const imported = await api.appThemeImport(path, onTaken);
        await reload();
        setClash(null);
        say(t("settings.appearance.colours.imported", { name: imported.name }));
      } catch (e) {
        const err = toApiError(e);
        if (err.code === "name_taken" && onTaken === "fail") {
          setClash({ path, name: err.detail ?? "" });
          return;
        }
        setClash(null);
        throw e;
      }
    }, (e) => t(importErrorKey(e)));

  const startImport = async () => {
    const path = await api.pickFile(THEME_FILE_EXTENSIONS).catch(() => null);
    if (path) await doImport(path, "fail");
  };

  const exportTheme = () =>
    current &&
    run(async () => {
      const path = await api.appThemeExport(current.id);
      if (path) say(t("settings.appearance.colours.exported", { path }));
    }, failKey("settings.appearance.colours.error.save"));

  const remove = () =>
    current &&
    run(async () => {
      await api.appThemeRemove(current.id);
      await props.onSelect("");
      await reload();
      say(t("settings.appearance.colours.deleted", { name: current.name }));
    }, failKey("settings.appearance.colours.error.save"));

  const options = [{ value: "", label: t("settings.appearance.colours.default") }, ...themes.map((x) => ({ value: x.id, label: x.name }))];

  return (
    <SettingGroup ids={IDS} filter={filter}>
      <h4 className="settings-group">{t("settings.appearance.colours.title")}</h4>
      <SettingRow id="appearance.colourTheme" filter={filter}>
        <div className="ws-fields">
          <div className="ws-field" data-field="colourTheme">
            <label htmlFor="colour-theme-select">{t("settings.appearance.colours.row")}</label>
            <Select
              id="colour-theme-select"
              data-field="colourThemeSelect"
              value={current ? current.id : ""}
              options={options}
              disabled={busy || editing !== null}
              onChange={(e) => void run(() => props.onSelect(e.target.value), failKey("settings.appearance.colours.error.save"))}
            />
            <small className="settings-hint">{t("settings.appearance.colours.hint")}</small>
            <div className="theme-actions">
              <Button type="button" variant="secondary" data-action="new" disabled={busy || editing !== null} onClick={() => setEditing({ theme: null })}>
                {t("settings.appearance.colours.new")}
              </Button>
              <Button type="button" variant="secondary" data-action="edit" disabled={busy || editing !== null || !current} onClick={() => setEditing({ theme: current })}>
                {t("settings.appearance.colours.edit")}
              </Button>
              <Button type="button" variant="secondary" data-action="import" disabled={busy || editing !== null} onClick={() => void startImport()}>
                {t("settings.appearance.colours.import")}
              </Button>
              <Button type="button" variant="secondary" data-action="export" disabled={busy || !current} onClick={() => void exportTheme()}>
                {t("settings.appearance.colours.export")}
              </Button>
              <Button type="button" variant="secondary" data-action="delete" disabled={busy || editing !== null || !current} onClick={() => void remove()}>
                {t("settings.appearance.colours.delete")}
              </Button>
            </div>
            {error && (
              <p className="error-text" role="alert" data-field="theme-colours-error">
                {error}
              </p>
            )}
            <p className="settings-hint" role="status" data-field="theme-colours-note">
              {note}
            </p>
          </div>
        </div>
        {editing && (
          <ThemeEditorPanel
            key={editing.theme?.id ?? "new"}
            api={api}
            theme={editing.theme}
            onSaved={onSaved}
            onCancel={() => setEditing(null)}
          />
        )}
        <ClashDialog
          name={clash?.name ?? null}
          busy={busy}
          onPick={(onTaken) => clash && void doImport(clash.path, onTaken)}
          onCancel={() => setClash(null)}
        />
      </SettingRow>
    </SettingGroup>
  );
}
