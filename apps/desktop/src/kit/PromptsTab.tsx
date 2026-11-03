import { Button } from "@xdev/ui";
import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type PromptEntry } from "../api";
import { useI18n } from "../i18n";
import { oneLine } from "./kitUi";
import { checkPrompt, namedPaths } from "./promptCheck";

const RECENT = 20;

/** The score of a prompt and each check behind it, with a hint for every check that failed. */
export function PromptChecks(props: { text: string; existing: Record<string, boolean> }): JSX.Element {
  const { t } = useI18n();
  const result = checkPrompt(props.text, props.existing);
  return (
    <section className="kit-checks" aria-label={t("kit.prompt.checks")}>
      <p className="kit-score" data-score={result.score}>{t("kit.prompt.score", { score: result.score })}</p>
      <p className="kit-note">{t("kit.tokens", { count: result.tokens })}</p>
      <ul className="kit-check-list">
        {result.checks.map((check) => (
          <li key={check.id} data-check={check.id} data-pass={check.pass ? "true" : "false"}>
            <span className="kit-dot" data-dot={check.pass ? "pass" : "fail"} />
            <span>{t(`kit.prompt.check.${check.id}`)}</span>
            {!check.pass && <span className="kit-hint">{t(check.hintKey)}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function PromptsTab(props: {
  api: Api;
  worktree: string | null;
  /** Types the text into the agent tab; `false` when there is no live one. */
  onSendToAgent?: (text: string) => Promise<boolean>;
}): JSX.Element {
  const { t } = useI18n();
  const { api, worktree } = props;
  const [text, setText] = useState("");
  const [existing, setExisting] = useState<Record<string, boolean>>({});
  const [recent, setRecent] = useState<PromptEntry[]>();
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();

  const named = useMemo(() => namedPaths(text), [text]);
  const key = named.join("\n");

  // Which of the named files exist in this worktree; with no worktree nothing is checked.
  useEffect(() => {
    if (worktree === null || named.length === 0) {
      setExisting({});
      return;
    }
    let stale = false;
    api.kitPathsExist(worktree, named).then(
      (found) => !stale && setExisting(Object.fromEntries(named.map((p, i) => [p, found[i] === true]))),
      () => !stale && setExisting({}),
    );
    return () => {
      stale = true;
    };
  }, [api, worktree, key]);

  async function loadRecent(): Promise<void> {
    setError(undefined);
    try {
      setRecent(await api.kitPromptHistory(RECENT));
    } catch (e) {
      setError(toApiError(e).code);
    }
  }

  async function send(): Promise<void> {
    setNote(undefined);
    // Typing a newline would press Enter and run the prompt, so lines are joined with a space.
    const line = text.replace(/\s*\r?\n\s*/g, " ").trim();
    const sent = props.onSendToAgent ? await props.onSendToAgent(line) : false;
    setNote(sent ? t("kit.prompt.sent") : t("kit.prompt.noTab"));
  }

  return (
    <div className="kit-prompts">
      <div className="kit-prompt-main">
        <label className="kit-field">
          <span>{t("kit.prompt.label")}</span>
          <textarea
            className="kit-input kit-textarea"
            rows={10}
            placeholder={t("kit.prompt.placeholder")}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <div className="kit-bar-row">
          <Button type="button" disabled={text.trim() === ""} onClick={() => void send()}>{t("kit.prompt.send")}</Button>
          <button type="button" className="btn-secondary" disabled title={t("kit.prompt.gradeOff")}>
            {t("kit.prompt.grade")}
          </button>
        </div>
        {note && <p className="kit-note" role="status">{note}</p>}
        {text.trim() === "" ? <p className="kit-empty">{t("kit.prompt.empty")}</p> : <PromptChecks text={text} existing={existing} />}
      </div>

      <section className="kit-block" aria-label={t("kit.prompt.recent")}>
        <h3 className="kit-h">{t("kit.prompt.recent")}</h3>
        {error && <p className="error-text" role="alert">{t(`error.${error}`)}</p>}
        {recent === undefined ? (
          <button type="button" className="btn-secondary" onClick={() => void loadRecent()}>{t("kit.prompt.recentLoad")}</button>
        ) : recent.length === 0 ? (
          <p className="kit-empty">{t("kit.prompt.recentNone")}</p>
        ) : (
          <ul className="kit-recent">
            {recent.map((entry, i) => (
              <li key={`${entry.at}-${i}`}>
                <span className="kit-cut" title={entry.text}>{oneLine(entry.text, 110)}</span>
                <button type="button" className="kit-link" onClick={() => setText(entry.text)}>{t("kit.prompt.use")}</button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
