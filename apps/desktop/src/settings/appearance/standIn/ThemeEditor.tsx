// Stand-in for @xdev-asia/ui ThemeEditor; delete when the pin has it.
import { Segmented } from "@xdev-asia/ui";
import type { JSX, ReactNode } from "react";
import { useI18n } from "@/i18n";
import { THEME_KEYS, type ContrastIssue, type ThemeColors, type ThemeGroup } from "@/ui/themeOverrides";
import { ColorField } from "./ColorField";
import { ThemePreview } from "./ThemePreview";

export const THEME_GROUPS: readonly ThemeGroup[] = ["surface", "text", "line", "accent", "status"];

export interface ThemeEditorProps {
  mode: "dark" | "light";
  onMode(mode: "dark" | "light"): void;
  name: string;
  onName(name: string): void;
  nameError?: string;
  /** The colour of every key in force for `mode`. */
  colors: Required<ThemeColors>;
  /** The keys the theme sets for `mode`. */
  overridden: ReadonlySet<string>;
  onColor(key: string, hex: string): void;
  onReset(key: string): void;
  issues: readonly ContrastIssue[];
  /** Extra fields under the name (the terminal scheme). */
  children?: ReactNode;
}

/** The fields of a theme: name, mode, colour groups, a preview and the contrast list. */
export function ThemeEditor(props: ThemeEditorProps): JSX.Element {
  const { t } = useI18n();
  const key = (k: string) => t(`settings.appearance.colours.key.${k}`);
  return (
    <div className="theme-editor">
      <label className="ws-field">
        <span>{t("settings.appearance.colours.name")}</span>
        <input
          type="text"
          data-field="themeName"
          value={props.name}
          maxLength={60}
          aria-invalid={props.nameError ? true : undefined}
          onChange={(e) => props.onName(e.target.value)}
        />
        {props.nameError && (
          <small className="error-text" role="alert">
            {props.nameError}
          </small>
        )}
      </label>
      {props.children}
      <div className="ws-field">
        <span>{t("settings.appearance.colours.mode")}</span>
        <Segmented
          label={t("settings.appearance.colours.mode")}
          value={props.mode}
          options={[
            { value: "dark", label: t("settings.appearance.colours.mode.dark") },
            { value: "light", label: t("settings.appearance.colours.mode.light") },
          ]}
          onChange={(next) => props.onMode(next as "dark" | "light")}
        />
      </div>
      {THEME_GROUPS.map((group) => (
        <fieldset className="theme-group" key={group} data-group={group}>
          <legend>{t(`settings.appearance.colours.group.${group}`)}</legend>
          {THEME_KEYS.filter((k) => k.group === group).map((k) => (
            <ColorField
              key={`${props.mode}-${k.key}`}
              data-key={k.key}
              label={key(k.key)}
              value={props.colors[k.key] ?? ""}
              overridden={props.overridden.has(k.key)}
              onChange={(hex) => props.onColor(k.key, hex)}
              onReset={() => props.onReset(k.key)}
              labels={{
                reset: t("settings.appearance.colours.reset", { token: key(k.key) }),
                picker: t("settings.appearance.colours.picker", { token: key(k.key) }),
                invalid: t("settings.appearance.colours.error.colour"),
              }}
            />
          ))}
        </fieldset>
      ))}
      <ThemePreview
        mode={props.mode}
        title={t("settings.appearance.colours.preview")}
        sample={t("settings.appearance.colours.previewText")}
        hint={t("settings.appearance.colours.previewHint")}
        button={t("settings.appearance.colours.previewButton")}
      />
      <section className="theme-contrast" aria-label={t("settings.appearance.colours.contrast")}>
        <h5>{t("settings.appearance.colours.contrast")}</h5>
        {props.issues.length === 0 ? (
          <p className="settings-hint" role="status" data-field="contrast-pass">
            {t("settings.appearance.colours.contrast.pass")}
          </p>
        ) : (
          <ul className="theme-contrast-list" role="status">
            {props.issues.map((i) => (
              <li key={`${i.fg}-${i.bg}`} data-pair={`${i.fg}/${i.bg}`}>
                {t("settings.appearance.colours.contrast.issue", { fg: key(i.fg), bg: key(i.bg), ratio: i.ratio, min: i.min })}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
