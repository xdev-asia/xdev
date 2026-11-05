import { ListRow, Textarea } from "@xdev-asia/ui";
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, JSX, KeyboardEvent, SyntheticEvent } from "react";
import { useI18n } from "@/i18n";
import { completionKey, insertCompletion, rankMatches, tokenAtCursor, type Token } from "./completion";

export type SkillItem = { name: string; description: string };

/** What a completion list needs loaded: skills for `/`, files for `@`. */
export type Need = "skills" | "files";

/**
 * The first-prompt box: typing `/` at the start of a word lists skills, `@` lists the worktree's files.
 * Up and Down move, Enter or Tab insert, Escape closes the list. The lists are loaded by the owner
 * (`onNeed` asks, `skills` and `files` answer); null means not loaded yet.
 */
export function PromptComposer(props: {
  value: string;
  onChange(value: string): void;
  skills: SkillItem[] | null;
  files: string[] | null;
  onNeed(need: Need): void;
  disabled?: boolean;
}): JSX.Element {
  const { t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const place = useRef<number | null>(null);
  const [cursor, setCursor] = useState(0);
  const [index, setIndex] = useState(0);
  const [closed, setClosed] = useState(false);

  // After an insert the cursor goes behind the inserted text, once the new value is drawn.
  useEffect(() => {
    const area = box.current?.querySelector("textarea");
    if (place.current !== null && area) {
      area.setSelectionRange(place.current, place.current);
      place.current = null;
    }
  });

  const token: Token | null = closed ? null : tokenAtCursor(props.value, cursor);
  const need: Need | null = token ? (token.trigger === "/" ? "skills" : "files") : null;
  const source = token?.trigger === "/" ? (props.skills ? props.skills.map((s) => s.name) : null) : (props.files ?? null);
  const matches = token && source ? rankMatches(source, token.query) : [];
  const describe = (name: string) => (token?.trigger === "/" ? props.skills?.find((s) => s.name === name)?.description : undefined);
  const loading = token !== null && source === null;
  const open = token !== null;
  const at = matches.length === 0 ? 0 : Math.min(index, matches.length - 1);
  const optionId = (i: number) => `agent-launch-complete-${i}`;

  const track = (e: SyntheticEvent<HTMLTextAreaElement>) => {
    const at = e.currentTarget.selectionStart;
    setCursor(at);
    const next = tokenAtCursor(props.value, at);
    if (next) props.onNeed(next.trigger === "/" ? "skills" : "files");
  };

  function accept(value: string) {
    if (!token) return;
    const done = insertCompletion(props.value, token, value);
    place.current = done.cursor;
    props.onChange(done.text);
    setCursor(done.cursor);
    setIndex(0);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (!open || e.nativeEvent.isComposing) return;
    const result = completionKey(e.key, at, matches.length);
    if (!result) return;
    // The list takes the key: Escape must not close the dialog around it.
    e.preventDefault();
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation?.();
    if (result.action === "accept") accept(matches[result.index]!);
    else if (result.action === "close") setClosed(true);
    else setIndex(result.index);
  }

  function onChange(e: ChangeEvent<HTMLTextAreaElement>) {
    props.onChange(e.target.value);
    setCursor(e.target.selectionStart);
    setIndex(0);
    setClosed(false);
    const next = tokenAtCursor(e.target.value, e.target.selectionStart);
    if (next) props.onNeed(next.trigger === "/" ? "skills" : "files");
  }

  return (
    <div className="agent-launch-composer" ref={box}>
      <Textarea
        mono
        rows={5}
        label={t("agentLaunch.prompt")}
        hint={t("agentLaunch.prompt.hint")}
        value={props.value}
        disabled={props.disabled}
        role="combobox"
        aria-expanded={open}
        aria-controls="agent-launch-complete"
        aria-autocomplete="list"
        aria-activedescendant={open && matches.length > 0 ? optionId(at) : undefined}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onKeyUp={track}
        onClick={track}
        onSelect={track}
      />
      {open && (
        <div className="agent-launch-complete" data-need={need ?? undefined}>
          <ul id="agent-launch-complete" role="listbox" aria-label={t(need === "skills" ? "agentLaunch.complete.skills" : "agentLaunch.complete.files")}>
            {matches.map((name, i) => (
              <li key={name} id={optionId(i)} role="option" aria-selected={i === at} onMouseDown={(e) => e.preventDefault()}>
                <ListRow
                  title={<span className="ws-mono">{token!.trigger + name}</span>}
                  meta={describe(name)}
                  selected={i === at}
                  onClick={() => accept(name)}
                />
              </li>
            ))}
          </ul>
          {matches.length === 0 && (
            <p className="agent-launch-complete-status" role="status">
              {loading ? t("agentLaunch.complete.loading") : t("agentLaunch.complete.empty")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
