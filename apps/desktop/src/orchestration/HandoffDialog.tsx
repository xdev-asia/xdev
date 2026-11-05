import { Dialog, Select, Textarea } from "@xdev-asia/ui";
import { useId, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import { toApiError, type Api } from "@/api";
import { useI18n } from "@/i18n";
import { applyMention, matchTabs, mentionAt, mentionDone, resolveMention, type Mention, type MentionTab } from "./mentions";

export interface HandoffDialogProps {
  api: Pick<Api, "orchestrationHandoff">;
  /** The live agent tabs, with a title each. */
  tabs: MentionTab[];
  /** The sending tab, or null to pick one. */
  from: string | null;
  onClose(): void;
  /** The hand-off went out; `to` is the title of the tab it went to. */
  onSent(to: string): void;
}

/** A message for another live tab: `@<tab title>` names it, with a listbox of the live tabs to pick from. */
export function HandoffDialog({ api, tabs, from: given, onClose, onSent }: HandoffDialogProps): JSX.Element {
  const { t } = useI18n();
  const id = useId();
  const listId = `${id}-tabs`;
  const [from, setFrom] = useState<string>(given ?? tabs[0]?.id ?? "");
  const [text, setText] = useState("");
  const [mention, setMention] = useState<Mention | null>(null);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const targets = tabs.filter((x) => x.id !== from);
  const options = mention && !mentionDone(targets, mention.query) ? matchTabs(targets, mention.query) : [];
  const open = mention !== null && options.length > 0;
  const resolved = resolveMention(text, targets);
  const sender = tabs.find((x) => x.id === from);
  const ready = !!sender && !!resolved && resolved.body !== "" && !busy;

  function follow(next: string, caret: number): void {
    setText(next);
    setError(null);
    setMention(mentionAt(next, caret));
    setActive(0);
  }

  function pick(tab: MentionTab): void {
    const el = area.current;
    if (!mention || !el) return;
    const caret = el.selectionStart ?? text.length;
    const out = applyMention(text, caret, mention, tab.title);
    setText(out.text);
    setMention(null);
    // After React writes the new value, or the caret lands in the old text.
    setTimeout(() => {
      el.focus();
      el.setSelectionRange(out.caret, out.caret);
    }, 0);
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (!open) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (a + step + options.length) % options.length);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive(e.key === "Home" ? 0 : options.length - 1);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      pick(options[Math.min(active, options.length - 1)]);
    } else if (e.key === "Escape") {
      // Closes the list only; a second Escape closes the dialog.
      e.stopPropagation();
      setMention(null);
    }
  }

  async function send(): Promise<void> {
    if (!ready || !resolved) return;
    setBusy(true);
    try {
      await api.orchestrationHandoff(from, resolved.tab.id, resolved.body);
      onSent(resolved.tab.title);
    } catch (e) {
      const err = toApiError(e);
      setError(err.detail ? t("mission.handoff.failedWith", { detail: err.detail }) : t("mission.handoff.failed"));
      setBusy(false);
    }
  }

  const optionId = (i: number) => `${id}-opt-${i}`;
  return (
    <Dialog
      modal
      title={t("mission.handoff.title")}
      confirmLabel={t("mission.handoff.send")}
      confirmDisabled={!ready}
      labels={{ cancel: t("mission.cancel") }}
      onConfirm={() => void send()}
      onCancel={onClose}
      body="plain"
    >
      <div className="mc-handoff">
        {given === null ? (
          <label className="ws-field">
            <span>{t("mission.handoff.from")}</span>
            <Select value={from} options={tabs.map((x) => ({ value: x.id, label: x.title }))} onChange={(e) => setFrom(e.target.value)} aria-label={t("mission.handoff.from")} />
          </label>
        ) : (
          <p className="mc-hint">{t("mission.handoff.fromTab", { name: sender?.title ?? given })}</p>
        )}
        <div className="mc-combo">
          <Textarea
            onFocus={(e) => (area.current = e.currentTarget)}
            label={t("mission.handoff.message")}
            hint={resolved ? t("mission.handoff.to", { name: resolved.tab.title }) : t("mission.handoff.hint")}
            error={error ?? undefined}
            placeholder={t("mission.handoff.placeholder")}
            resize="none"
            rows={4}
            value={text}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={listId}
            aria-activedescendant={open ? optionId(Math.min(active, options.length - 1)) : undefined}
            onChange={(e) => {
              area.current = e.target;
              follow(e.target.value, e.target.selectionStart ?? e.target.value.length);
            }}
            onClick={(e) => setMention(mentionAt(e.currentTarget.value, e.currentTarget.selectionStart ?? e.currentTarget.value.length))}
            onKeyDown={onKey}
          />
          <ul id={listId} role="listbox" className="mc-options" aria-label={t("mission.handoff.tabs")} hidden={!open}>
            {options.map((x, i) => (
              <li
                key={x.id}
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                className="mc-option"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(x)}
              >
                {x.title}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Dialog>
  );
}
