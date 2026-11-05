import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { AgentsSettings, Api, PathEntry } from "@/api";
import { toApiError } from "@/api";
import { useI18n } from "@/i18n";
import { separatorFor, validateEntry, type EntryProblem } from "./pathEntries";

type Place = "prepend" | "append";

/** The PATH separator of the machine the window runs on; the mock api runs in a browser. */
function hostSeparator(): string {
  return separatorFor(typeof navigator !== "undefined" && /win/i.test(navigator.platform ?? ""));
}

/**
 * The PATH new terminals and agents get: every directory in order, the missing ones marked, the
 * system ones read-only, and the owner's own prepend and append entries added or removed.
 */
export function PathSection(props: {
  api: Pick<Api, "agentsSettings" | "agentsSettingsPut" | "pathEffective">;
  /** The PATH separator; the machine's own when absent. */
  separator?: string;
}): JSX.Element {
  const { api } = props;
  const { t } = useI18n();
  const [entries, setEntries] = useState<PathEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [place, setPlace] = useState<Place>("append");
  const [problem, setProblem] = useState<EntryProblem>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    api.pathEffective().then(setEntries, () => setFailed(true));
  }, [api]);

  // Read the stored lists again before the put: another page may have saved other agent settings.
  async function change(edit: (s: AgentsSettings) => AgentsSettings, done: string): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setFailed(false);
    try {
      await api.agentsSettingsPut(edit(await api.agentsSettings()));
      setEntries(await api.pathEffective());
      setNote(done);
      return true;
    } catch (e) {
      setFailed(true);
      void toApiError(e);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(): Promise<void> {
    const v = validateEntry(draft, props.separator ?? hostSeparator());
    if ("problem" in v) {
      setProblem(v.problem);
      return;
    }
    setProblem(undefined);
    const key = place === "prepend" ? "pathPrepend" : "pathAppend";
    const ok = await change((s) => ({ ...s, [key]: [...s[key], v.ok] }), t("settings.path.added", { path: v.ok }));
    if (ok) setDraft("");
  }

  const remove = (e: PathEntry) => {
    const key = e.source === "prepend" ? "pathPrepend" : "pathAppend";
    void change((s) => ({ ...s, [key]: s[key].filter((p) => p !== e.path) }), t("settings.path.removed", { path: e.path }));
  };

  return (
    <>
      <h4 className="settings-group">{t("settings.path.title")}</h4>
      <small className="settings-hint">{t("settings.path.hint")}</small>
      <ol className="settings-list" aria-label={t("settings.path.title")} data-path-list>
        {entries.map((e) => (
          <li key={`${e.source}:${e.path}`} className="settings-item" data-path-entry={e.path} data-source={e.source}>
            <div className="settings-item-text">
              <strong className="settings-path">{e.path}</strong>
              <span className="settings-path">
                {t(`settings.path.source.${e.source}`)}
                {!e.exists && ` · ${t("settings.path.missing")}`}
              </span>
            </div>
            {e.source !== "system" && (
              <button
                type="button"
                className="btn-secondary"
                disabled={busy}
                aria-label={t("settings.path.remove", { path: e.path })}
                onClick={() => remove(e)}
              >
                {t("settings.agents.remove")}
              </button>
            )}
          </li>
        ))}
      </ol>
      <div className="ws-fields">
        <label className="ws-field">
          <span>{t("settings.path.folder")}</span>
          <input
            value={draft}
            data-field="path-entry"
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? "path-entry-error" : undefined}
            onChange={(e) => {
              setDraft(e.target.value);
              setProblem(undefined);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void add();
              }
            }}
          />
        </label>
        <label className="ws-field">
          <span>{t("settings.path.place")}</span>
          <select value={place} data-field="path-place" onChange={(e) => setPlace(e.target.value as Place)}>
            <option value="prepend">{t("settings.path.source.prepend")}</option>
            <option value="append">{t("settings.path.source.append")}</option>
          </select>
        </label>
      </div>
      {problem && (
        <p id="path-entry-error" className="error-text" role="alert">
          {t(`settings.path.error.${problem}`)}
        </p>
      )}
      {failed && (
        <p className="error-text" role="alert">
          {t("settings.path.error.save")}
        </p>
      )}
      <div className="settings-actions">
        <button type="button" className="btn-secondary" data-act="path-add" disabled={busy} onClick={() => void add()}>
          {t("settings.path.add")}
        </button>
      </div>
      <span role="status" className="x-sr-only" data-testid="path-status">
        {note}
      </span>
    </>
  );
}
