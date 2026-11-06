import { Button, Dialog, Field } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { FormEvent, JSX } from "react";
import type { CloudSettings } from "@xdev/bindings";
import { toApiError, type Api, type ApiError } from "@/api";
import { useI18n } from "@/i18n";
import { SettingRow } from "../SettingRow";
import type { SettingsFilter } from "../sections";
import { rootFingerprint } from "./rootFingerprint";

export type ServerPanelApi = Pick<Api, "cloudSettings" | "cloudSettingsPut">;

type Props = {
  api: ServerPanelApi;
  filter?: SettingsFilter;
};

const DEFAULT_SERVER = "https://id.xdev.asia";

const norm = (url: string): string => url.trim().replace(/\/+$/, "");

/** Settings → Cloud → Server: where the license and xDev ID live, and the keys their tokens are trusted under. */
export function ServerPanel({ api, filter }: Props): JSX.Element {
  const { t } = useI18n();
  const [saved, setSaved] = useState<CloudSettings | null>(null);
  const [server, setServer] = useState("");
  const [roots, setRoots] = useState<string[]>([""]);
  const [error, setError] = useState<ApiError["code"]>();
  const [confirm, setConfirm] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let live = true;
    void api.cloudSettings().then(
      (s) => {
        if (!live) return;
        setSaved(s);
        setServer(s.serverUrl ?? "");
        setRoots(s.pinnedRoots.length > 0 ? s.pinnedRoots : [""]);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api]);

  if (!saved) return <></>;

  const custom = norm(server) !== "" && norm(server) !== DEFAULT_SERVER;
  const filled = roots.map((r) => r.trim()).filter((r) => r !== "");
  const prints = roots.map((r) => (r.trim() === "" ? null : rootFingerprint(r)));
  const badRoot = roots.some((r, i) => r.trim() !== "" && prints[i] === null);
  const needRoot = custom && filled.length === 0;
  // A different server signs the person out, so it asks first.
  const moved = (custom ? norm(server) : "") !== (saved.serverUrl ?? "");
  const same = !moved && JSON.stringify(custom ? filled : []) === JSON.stringify(saved.pinnedRoots);

  function apply(): void {
    setConfirm(false);
    setError(undefined);
    setDone(false);
    api.cloudSettingsPut({ serverUrl: custom ? norm(server) : null, pinnedRoots: custom ? filled : [] }).then(
      (s) => {
        setSaved(s);
        setServer(s.serverUrl ?? "");
        setRoots(s.pinnedRoots.length > 0 ? s.pinnedRoots : [""]);
        setDone(true);
      },
      (e: unknown) => setError(toApiError(e).code),
    );
  }

  function submit(e: FormEvent): void {
    e.preventDefault();
    if (needRoot || badRoot || same) return;
    if (moved) setConfirm(true);
    else apply();
  }

  const setRoot = (i: number, value: string): void => {
    setDone(false);
    setRoots((all) => all.map((r, at) => (at === i ? value : r)));
  };

  return (
    <SettingRow id="cloud.server" filter={filter}>
      <div className="settings-card" data-setting="cloud-server">
        <div className="settings-item-text">
          <strong>{t("cloud.server.title")}</strong>
          <span className="settings-hint">{t("cloud.server.hint")}</span>
        </div>
        <form onSubmit={submit}>
          <Field
            label={t("cloud.server.label")}
            value={server}
            placeholder="https://license.example.com"
            onChange={(e) => {
              setDone(false);
              setServer(e.target.value);
            }}
            autoComplete="off"
            spellCheck={false}
          />
          {roots.map((root, i) => (
            <Field
              key={i}
              label={t("cloud.root.label", { n: i + 1 })}
              hint={prints[i] ? t("cloud.root.fingerprint", { fingerprint: prints[i] }) : t("cloud.root.hint")}
              error={root.trim() !== "" && prints[i] === null ? t("error.cloud_bad_root") : undefined}
              value={root}
              onChange={(e) => setRoot(i, e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          ))}
          {needRoot && (
            <p className="settings-hint" role="alert">
              {t("cloud.err.needRoot")}
            </p>
          )}
          {error && (
            <p className="settings-hint" role="alert">
              {t(`error.${error}`)}
            </p>
          )}
          {done && (
            <span className="settings-saved" role="status">
              {t("cloud.saved")}
            </span>
          )}
          <div className="settings-actions settings-actions-start">
            <Button type="submit" variant="secondary" disabled={same || needRoot || badRoot}>
              {t("cloud.save")}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setRoots((all) => [...all, ""])}>
              {t("cloud.root.add")}
            </Button>
            {roots.length > 1 && (
              <Button type="button" variant="secondary" onClick={() => setRoots((all) => all.slice(0, -1))}>
                {t("cloud.root.remove")}
              </Button>
            )}
          </div>
        </form>
        {confirm && (
          <Dialog modal alert title={t("cloud.confirm.title")} confirmLabel={t("cloud.confirm.yes")} cancelLabel={t("cloud.confirm.no")} onConfirm={apply} onCancel={() => setConfirm(false)}>
            {t("cloud.confirm.body")}
          </Dialog>
        )}
      </div>
    </SettingRow>
  );
}
