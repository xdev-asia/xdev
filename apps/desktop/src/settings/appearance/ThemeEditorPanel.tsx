import { Button, Select, ThemeEditor } from "@xdev-asia/ui";
import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type AppTheme, type AppThemeInput } from "@/api";
import { useI18n } from "@/i18n";
import { endPreview, paintedMode, previewAppTheme, readBuiltIn, type BuiltIn } from "@/ui/appTheme";
import { TERMINAL_SCHEMES } from "@/terminal/terminalThemes";
import { contrastIssues, THEME_GROUPS, THEME_KEYS, type ThemeColors } from "@/ui/themeOverrides";

type Mode = "dark" | "light";
type Draft = { name: string; dark: ThemeColors; light: ThemeColors; terminalScheme: string };

/** The message key of an error from a save. */
export function saveErrorKey(e: unknown): { key: string; vars?: Record<string, string> } {
  const err = toApiError(e);
  if (err.code === "name_taken") return { key: "settings.appearance.colours.error.taken", vars: { name: err.detail ?? "" } };
  if (err.code === "theme_invalid" && err.detail === "name") return { key: "settings.appearance.colours.error.name" };
  if (err.code === "theme_invalid") return { key: "settings.appearance.colours.error.colour" };
  return { key: "settings.appearance.colours.error.save" };
}

/** The input a save sends: only the keys the theme sets, and the terminal scheme when one is picked. */
export function themeInput(id: string | undefined, d: Draft): AppThemeInput {
  const input: AppThemeInput = { name: d.name.trim(), dark: { ...d.dark } as Record<string, string>, light: { ...d.light } as Record<string, string> };
  if (id !== undefined) input.id = id;
  if (d.terminalScheme !== "") input.terminalScheme = d.terminalScheme;
  return input;
}

/** The editor of one theme: live while open, saved on Save, undone on Cancel. */
export function ThemeEditorPanel(props: {
  api: Pick<Api, "appThemeSave" | "terminalThemes">;
  /** The theme to edit; null makes a new one. */
  theme: AppTheme | null;
  onSaved(theme: AppTheme): void | Promise<void>;
  onCancel(): void;
}): JSX.Element {
  const { api, theme } = props;
  const { t } = useI18n();
  const [builtIn] = useState<Record<Mode, BuiltIn>>(() => ({ dark: readBuiltIn("dark"), light: readBuiltIn("light") }));
  const [mode, setMode] = useState<Mode>(() => paintedMode());
  const [draft, setDraft] = useState<Draft>(() => ({
    name: theme?.name ?? "",
    dark: { ...theme?.dark },
    light: { ...theme?.light },
    terminalScheme: theme?.terminalScheme ?? "",
  }));
  const [custom, setCustom] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<{ key: string; vars?: Record<string, string> }>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api.terminalThemes().then(
      (list) => live && setCustom(list.map((s) => ({ id: s.id, name: s.name }))),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [api]);

  // The window shows the draft while the panel is open; closing it paints the active theme again.
  useEffect(() => {
    previewAppTheme({ dark: draft.dark, light: draft.light });
  }, [draft.dark, draft.light]);
  useEffect(() => endPreview, []);

  const effective = useMemo(() => ({ ...builtIn[mode].colors, ...draft[mode] }) as Record<string, string>, [builtIn, mode, draft]);
  const issues = useMemo(() => contrastIssues(effective, { "on-accent": builtIn[mode].onAccent }), [effective, builtIn, mode]);
  const overridden = useMemo(() => new Set(Object.keys(draft[mode])), [draft, mode]);

  const keyLabel = (k: string) => t(`settings.appearance.colours.key.${k}`);
  const groups = THEME_GROUPS.map((g) => ({
    id: g,
    title: t(`settings.appearance.colours.group.${g}`),
    keys: THEME_KEYS.filter((k) => k.group === g).map((k) => ({ key: k.key, label: keyLabel(k.key) })),
  }));
  // The library prints the key's label before each message, so the message starts after it.
  const themeIssues = issues.map((i) => {
    const vars = { fg: keyLabel(i.fg), bg: keyLabel(i.bg), ratio: i.ratio, min: i.min };
    // "on-accent" is not an editable key: the issue sits on the accent it is drawn over.
    return THEME_KEYS.some((k) => k.key === i.fg)
      ? { key: i.fg, message: t("settings.appearance.colours.contrast.issue", vars) }
      : { key: i.bg, message: t("settings.appearance.colours.contrast.issueBehind", vars) };
  });
  const editorLabels = {
    name: t("settings.appearance.colours.name"),
    mode: t("settings.appearance.colours.mode"),
    dark: t("settings.appearance.colours.mode.dark"),
    light: t("settings.appearance.colours.mode.light"),
    reset: t("settings.appearance.colours.reset", { token: "{token}" }),
    picker: t("settings.appearance.colours.picker", { token: "{token}" }),
    invalid: t("settings.appearance.colours.error.colour"),
    preview: {
      title: t("settings.appearance.colours.preview"),
      sample: t("settings.appearance.colours.previewText"),
      hint: t("settings.appearance.colours.previewHint"),
      button: t("settings.appearance.colours.previewButton"),
    },
    issuesTitle: t("settings.appearance.colours.contrast"),
    noIssues: t("settings.appearance.colours.contrast.pass"),
  };

  const setColor = (key: string, hex: string) => setDraft((d) => ({ ...d, [mode]: { ...d[mode], [key]: hex } }));
  const resetColor = (key: string) =>
    setDraft((d) => {
      const next = { ...d[mode] };
      delete next[key];
      return { ...d, [mode]: next };
    });

  const schemes = [
    { value: "", label: t("settings.appearance.colours.terminal.keep") },
    ...TERMINAL_SCHEMES.map((s) => ({ value: s.id, label: s.name })),
    ...custom.map((s) => ({ value: s.id, label: s.name })),
  ];
  // A theme may name a scheme this machine lacks: keep it selectable so a save does not drop it.
  if (!schemes.some((s) => s.value === draft.terminalScheme)) schemes.push({ value: draft.terminalScheme, label: draft.terminalScheme });

  async function submit(): Promise<void> {
    if (busy) return;
    if (draft.name.trim() === "") {
      setError({ key: "settings.appearance.colours.error.name" });
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const saved = await api.appThemeSave(themeInput(theme?.id, draft));
      await props.onSaved(saved);
    } catch (e) {
      setError(saveErrorKey(e));
      setBusy(false);
    }
  }

  const nameError = error && error.key !== "settings.appearance.colours.error.save" && error.key !== "settings.appearance.colours.error.colour" ? t(error.key, error.vars) : undefined;
  const formError = error && !nameError ? t(error.key, error.vars) : undefined;

  return (
    <form
      className="theme-panel"
      aria-label={theme ? t("settings.appearance.colours.panel.edit", { name: theme.name }) : t("settings.appearance.colours.panel.new")}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h4 className="theme-panel-title">{theme ? t("settings.appearance.colours.panel.edit", { name: theme.name }) : t("settings.appearance.colours.panel.new")}</h4>
      <ThemeEditor
        mode={mode}
        onMode={setMode}
        name={draft.name}
        onName={(name) => {
          setError(undefined);
          setDraft((d) => ({ ...d, name }));
        }}
        nameError={nameError}
        colors={effective}
        overridden={overridden}
        onColor={setColor}
        onReset={resetColor}
        groups={groups}
        issues={themeIssues}
        labels={editorLabels}
      >
        <label className="ws-field">
          <span>{t("settings.appearance.colours.terminal")}</span>
          <Select
            data-field="terminalScheme"
            value={draft.terminalScheme}
            options={schemes}
            onChange={(e) => setDraft((d) => ({ ...d, terminalScheme: e.target.value }))}
          />
        </label>
      </ThemeEditor>
      {formError && (
        <p className="error-text" role="alert" data-field="theme-error">
          {formError}
        </p>
      )}
      <div className="theme-panel-actions">
        <Button variant="primary" type="submit" data-action="save" disabled={busy}>
          {t("settings.appearance.colours.save")}
        </Button>
        <Button type="button" variant="secondary" data-action="cancel" disabled={busy} onClick={props.onCancel}>
          {t("settings.appearance.colours.cancel")}
        </Button>
        <Button type="button" variant="secondary" data-action="resetAll" disabled={busy} onClick={() => setDraft((d) => ({ ...d, dark: {}, light: {} }))}>
          {t("settings.appearance.colours.resetAll")}
        </Button>
      </div>
    </form>
  );
}
