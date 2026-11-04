import type { JSX } from "react";
import type { GhAccount, GhLogin, RepoIcon, RepoPatch, RepoView } from "@/api";
import { EMOJI } from "@/workspace/emoji";
import { REPO_COLORS } from "@/workspace/repoIdentity";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The identity and account edits typed but not saved, per repo. `undefined` means untouched. */
export type IdentityDraft = {
  color?: string | null;
  icon?: RepoIcon | null;
  iconTab?: IconTab;
  ghAccount?: GhAccount | null;
};
export type IconTab = "letter" | "emoji";

const isPreset = (color: string | null): boolean => color !== null && (REPO_COLORS as readonly string[]).includes(color);
const normalIcon = (icon: RepoIcon | null): RepoIcon | null => (icon?.kind === "emoji" ? icon : null);
const sameIcon = (a: RepoIcon | null, b: RepoIcon | null): boolean => normalIcon(a)?.kind === normalIcon(b)?.kind && (normalIcon(a) as { value?: string } | null)?.value === (normalIcon(b) as { value?: string } | null)?.value;
const sameAccount = (a: GhAccount | null, b: GhAccount | null): boolean => a?.host === b?.host && a?.user === b?.user;

/** What the form shows for a repo: the draft over what is stored. */
export function shown(repo: RepoView, draft: IdentityDraft | undefined) {
  const icon = draft?.icon !== undefined ? draft.icon : repo.icon;
  return {
    color: draft?.color !== undefined ? draft.color : repo.color,
    icon,
    tab: draft?.iconTab ?? (normalIcon(icon) ? "emoji" : "letter"),
    ghAccount: draft?.ghAccount !== undefined ? draft.ghAccount : repo.ghAccount,
  } as { color: string | null; icon: RepoIcon | null; tab: IconTab; ghAccount: GhAccount | null };
}

/** The fields of the patch the draft changes; a field equal to what is stored is left out. */
export function identityPatch(repo: RepoView, draft: IdentityDraft | undefined): Pick<RepoPatch, "color" | "icon" | "ghAccount"> {
  const now = shown(repo, draft);
  const patch: Pick<RepoPatch, "color" | "icon" | "ghAccount"> = {};
  if (now.color !== repo.color) patch.color = now.color;
  if (!sameIcon(now.icon, repo.icon)) patch.icon = normalIcon(now.icon);
  if (!sameAccount(now.ghAccount, repo.ghAccount)) patch.ghAccount = now.ghAccount;
  return patch;
}

type Ctx = { t: T; repo: RepoView; draft: IdentityDraft | undefined; disabled: boolean; error: JSX.Element | null; edit(next: Partial<IdentityDraft>): void };

const swatchLabel = (t: T, name: string): string => t(`settings.repos.identity.color.${name}`);

export function colorField(c: Ctx): JSX.Element {
  const { t, repo } = c;
  const { color } = shown(repo, c.draft);
  const names = ["none", ...REPO_COLORS];
  return (
    <div className="ws-field" role="radiogroup" aria-label={t("settings.repos.identity.color")}>
      <span>{t("settings.repos.identity.color")}</span>
      <div className="ws-swatches">
        {names.map((name) => (
          <label key={name} className="ws-swatch-opt" title={swatchLabel(t, name)}>
            <input
              type="radio"
              name="color"
              value={name}
              aria-label={swatchLabel(t, name)}
              checked={name === "none" ? color === null : color === name}
              disabled={c.disabled}
              onChange={() => c.edit({ color: name === "none" ? null : name })}
            />
            <span className={`ws-swatch ${name === "none" ? "ws-swatch-none" : `ws-badge-tag-${name}`}`} />
          </label>
        ))}
      </div>
      <label className="ws-field">
        <span>{t("settings.repos.identity.color.custom")}</span>
        <input
          type="text"
          name="colorHex"
          className="ws-mono"
          placeholder="#3a7"
          value={color !== null && !isPreset(color) ? color : ""}
          spellCheck={false}
          disabled={c.disabled}
          aria-invalid={c.error ? true : undefined}
          onChange={(e) => c.edit({ color: e.target.value.trim() === "" ? null : e.target.value.trim() })}
        />
      </label>
      {c.error}
      <small className="settings-hint">{t("settings.repos.identity.color.hint")}</small>
    </div>
  );
}

export function iconField(c: Ctx): JSX.Element {
  const { t, repo } = c;
  const { icon, tab } = shown(repo, c.draft);
  const value = icon?.kind === "emoji" ? icon.value : "";
  return (
    <div className="ws-field" role="group" aria-label={t("settings.repos.identity.icon")}>
      <span>{t("settings.repos.identity.icon")}</span>
      <div className="ws-icon-tabs" role="tablist" aria-label={t("settings.repos.identity.icon")}>
        {(["letter", "emoji"] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            role="tab"
            className="btn-secondary"
            data-icon-tab={kind}
            aria-selected={tab === kind}
            disabled={c.disabled}
            onClick={() => c.edit(kind === "letter" ? { iconTab: "letter", icon: null } : { iconTab: "emoji" })}
          >
            {t(`settings.repos.identity.icon.${kind}`)}
          </button>
        ))}
      </div>
      {tab === "emoji" && (
        <>
          <div className="ws-emoji-grid" role="group" aria-label={t("settings.repos.identity.icon.pick")}>
            {Object.entries(EMOJI).map(([name, glyph]) => (
              <button key={name} type="button" className="ws-emoji-cell" data-emoji={glyph} aria-label={name} aria-pressed={value === glyph} disabled={c.disabled} onClick={() => c.edit({ icon: { kind: "emoji", value: glyph } })}>
                {glyph}
              </button>
            ))}
          </div>
          <label className="ws-field">
            <span>{t("settings.repos.identity.icon.free")}</span>
            <input
              type="text"
              name="iconEmoji"
              value={value}
              spellCheck={false}
              disabled={c.disabled}
              aria-invalid={c.error ? true : undefined}
              onChange={(e) => c.edit({ icon: e.target.value.trim() === "" ? null : { kind: "emoji", value: e.target.value.trim() } })}
            />
          </label>
        </>
      )}
      {c.error}
    </div>
  );
}

const loginKey = (a: GhAccount): string => `${a.host}|${a.user}`;
const loginLabel = (a: GhAccount): string => `${a.user} · ${a.host}`;

export type GhState = { logins: GhLogin[] | null; error: string | null; loading: boolean };

export function ghField(c: Ctx & { gh: GhState; refresh(): void }): JSX.Element {
  const { t, repo, gh } = c;
  const { ghAccount } = shown(repo, c.draft);
  // The login is bound but gh does not list it: kept selected, so saving never rebinds it silently.
  const known = gh.logins === null || gh.error !== null || ghAccount === null || gh.logins.some((l) => sameAccount(l, ghAccount));
  return (
    <div className="ws-field">
      <label className="ws-field">
        <span>{t("settings.repos.gh")}</span>
        <select
          name="ghAccount"
          value={ghAccount ? loginKey(ghAccount) : ""}
          disabled={c.disabled}
          onChange={(e) => {
            const [host, ...user] = e.target.value.split("|");
            c.edit({ ghAccount: e.target.value === "" ? null : { host, user: user.join("|") } });
          }}
        >
          <option value="">{t("settings.repos.gh.default")}</option>
          {(gh.logins ?? []).map((l) => (
            <option key={loginKey(l)} value={loginKey(l)}>
              {loginLabel(l)}
            </option>
          ))}
          {ghAccount && !(gh.logins ?? []).some((l) => sameAccount(l, ghAccount)) && (
            <option value={loginKey(ghAccount)}>{known ? loginLabel(ghAccount) : t("settings.repos.gh.gone", { user: ghAccount.user, host: ghAccount.host })}</option>
          )}
        </select>
      </label>
      <div className="settings-row">
        <button type="button" className="btn-secondary" data-gh-refresh disabled={gh.loading} onClick={c.refresh}>
          {t("settings.repos.gh.refresh")}
        </button>
      </div>
      {gh.error !== null && (
        <small className="settings-hint" role="status">
          {t("settings.repos.gh.unavailable", { error: gh.error })}
        </small>
      )}
      {!known && (
        <small className="error-text settings-error" role="alert">
          {t("settings.repos.gh.goneNote")}
        </small>
      )}
      <small className="settings-hint">{t("settings.repos.gh.hint")}</small>
    </div>
  );
}
