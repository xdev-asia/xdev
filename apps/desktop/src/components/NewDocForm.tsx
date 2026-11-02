import { Button } from "@xdev/ui";
import { useState } from "react";
import type { JSX } from "react";
import type { ApiError } from "../api";
import { useI18n } from "../i18n";
import { COMPACT } from "./ChangesPanel";

export function NewDocForm(props: {
  busy: boolean;
  error?: ApiError["code"];
  onCreate(title: string): void;
  onCancel(): void;
}): JSX.Element {
  const { t } = useI18n();
  const [title, setTitle] = useState("");
  const empty = title.trim() === "";
  return (
    <form
      className="newdoc"
      onSubmit={(e) => {
        e.preventDefault();
        if (!empty && !props.busy) props.onCreate(title);
      }}
    >
      <input
        aria-label={t("newDoc.name")}
        placeholder={t("newDoc.name")}
        value={title}
        disabled={props.busy}
        autoFocus
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") props.onCancel();
        }}
      />
      {props.error && (
        <p className="error-text" role="alert">
          {t(`error.${props.error}`)}
        </p>
      )}
      <div className="newdoc-actions">
        <button type="button" className="btn-secondary" disabled={props.busy} onClick={props.onCancel}>
          {t("newDoc.cancel")}
        </button>
        <Button type="submit" style={COMPACT} disabled={empty || props.busy}>
          {t("newDoc.create")}
        </Button>
      </div>
    </form>
  );
}
