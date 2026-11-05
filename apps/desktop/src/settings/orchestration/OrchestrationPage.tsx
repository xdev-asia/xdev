import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { toApiError, type OrchestrationSettings, type SkillStatus } from "@/api";
import { useI18n } from "@/i18n";
import { SettingRow } from "../SettingRow";
import type { SettingsSectionProps } from "../sections";
import { HowToCards } from "./HowToCards";
import { DEPTH_MAX, DEPTH_MIN, parseDepth, type HowToId } from "./howTo";
import { SkillCard } from "./SkillCard";

const COPIED_MS = 2000;

async function writeClipboard(text: string): Promise<void> {
  await Promise.resolve(navigator.clipboard?.writeText(text)).catch(() => undefined);
}

/** Settings → Orchestration: the skill, how deep workers nest, auto-close, and starter prompts. */
export function OrchestrationPage(props: SettingsSectionProps): JSX.Element {
  const { api, filter } = props;
  const { t } = useI18n();
  const [settings, setSettings] = useState<OrchestrationSettings | null>(null);
  const [depthText, setDepthText] = useState("1");
  const [status, setStatus] = useState<SkillStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [skillError, setSkillError] = useState<string>();
  const [copied, setCopied] = useState<"command" | "prompt" | null>(null);
  const [howTo, setHowTo] = useState<HowToId | null>(null);
  const saving = useRef(false);
  // Changes made while a save runs; the latest of each field is saved next.
  const queued = useRef<Partial<OrchestrationSettings> | null>(null);
  const installing = useRef(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    api.orchestrationSettings().then(
      (s) => {
        setSettings(s);
        setDepthText(String(s.nestedWorkerMaxDepth));
      },
      (e) => setError(toApiError(e).code),
    );
    void refresh();
    return () => clearTimeout(copyTimer.current);
  }, [api]);

  // The status is read again by Install and Re-check; null shows "Checking…".
  async function refresh(): Promise<void> {
    setSkillError(undefined);
    setStatus(null);
    try {
      setStatus(await api.orchestrationSkillStatus());
    } catch (e) {
      setSkillError(toApiError(e).code);
    }
  }

  async function install(force = false): Promise<void> {
    if (installing.current) return;
    installing.current = true;
    setBusy(true);
    setSkillError(undefined);
    try {
      setStatus(await (force ? api.orchestrationSkillInstall(true) : api.orchestrationSkillInstall()));
    } catch (e) {
      setSkillError(toApiError(e).code);
    } finally {
      installing.current = false;
      setBusy(false);
    }
  }

  async function uninstall(): Promise<void> {
    if (installing.current) return;
    installing.current = true;
    setBusy(true);
    setSkillError(undefined);
    try {
      setStatus(await api.orchestrationSkillUninstall());
    } catch (e) {
      setSkillError(toApiError(e).code);
    } finally {
      installing.current = false;
      setBusy(false);
    }
  }

  // Each write returns what was stored (the depth is clamped there too); the page shows that.
  async function patch(change: Partial<OrchestrationSettings>): Promise<void> {
    if (settings === null) return;
    if (saving.current) {
      queued.current = { ...queued.current, ...change };
      return;
    }
    saving.current = true;
    let base = settings;
    let next: Partial<OrchestrationSettings> | null = change;
    try {
      while (next) {
        try {
          base = await api.orchestrationSettingsPut({ ...base, ...next });
          setSettings(base);
          setError(undefined);
        } catch (e) {
          setError(toApiError(e).code);
        }
        setDepthText(String(base.nestedWorkerMaxDepth));
        next = queued.current;
        queued.current = null;
      }
    } finally {
      saving.current = false;
    }
  }

  function flash(what: "command" | "prompt"): void {
    setCopied(what);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(null), COPIED_MS);
  }

  const commitDepth = (): void => {
    if (settings === null) return;
    const next = parseDepth(depthText, settings.nestedWorkerMaxDepth);
    if (next === settings.nestedWorkerMaxDepth) setDepthText(String(next));
    else void patch({ nestedWorkerMaxDepth: next });
  };

  return (
    <div className="settings-page orchestration-page">
      <header className="settings-head">
        <h3>{t("settings.orchestration.title")}</h3>
        <p>{t("settings.orchestration.intro")}</p>
      </header>
      {error && (
        <p className="error-text" role="alert">
          {t(`error.${error}`)}
        </p>
      )}

      <SettingRow id="orchestration.skill" filter={filter}>
        <SkillCard
          status={status}
          busy={busy}
          copied={copied === "command"}
          error={skillError}
          onInstall={() => void install()}
          onReplace={() => void install(true)}
          onUninstall={() => void uninstall()}
          onRecheck={() => void refresh()}
          onCopyCommand={() => {
            if (status === null) return;
            void writeClipboard(status.installCommand);
            flash("command");
          }}
        />
      </SettingRow>

      <SettingRow id="orchestration.depth" filter={filter}>
        <label className="ws-field settings-item" data-setting-field="depth">
          <span className="settings-item-text">
            <strong>{t("settings.orchestration.depth.label")}</strong>
            <span className="settings-path">{t("settings.orchestration.depth.hint")}</span>
          </span>
          <input
            type="number"
            inputMode="numeric"
            min={DEPTH_MIN}
            max={DEPTH_MAX}
            step={1}
            data-field="depth"
            value={depthText}
            disabled={settings === null}
            onChange={(e) => setDepthText(e.target.value)}
            onBlur={commitDepth}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitDepth();
            }}
          />
        </label>
      </SettingRow>

      <SettingRow id="orchestration.autoClose" filter={filter}>
        <div className="settings-item" data-switch="autoClose">
          <div className="settings-item-text">
            <strong>{t("settings.orchestration.autoClose.label")}</strong>
            <span className="settings-path">{t("settings.orchestration.autoClose.hint")}</span>
          </div>
          <button
            type="button"
            role="switch"
            className="agent-switch"
            data-act="auto-close"
            aria-checked={settings?.workerAutoClose ?? true}
            aria-label={t("settings.orchestration.autoClose.label")}
            disabled={settings === null}
            onClick={() => void patch({ workerAutoClose: !settings!.workerAutoClose })}
          />
        </div>
      </SettingRow>

      <SettingRow id="orchestration.howTo" filter={filter}>
        <h4 className="settings-group">{t("settings.orchestration.howTo.title")}</h4>
        <HowToCards
          open={howTo}
          copied={copied === "prompt"}
          onOpen={setHowTo}
          onClose={() => setHowTo(null)}
          onCopy={(text) => {
            void writeClipboard(text);
            flash("prompt");
          }}
        />
      </SettingRow>
    </div>
  );
}
