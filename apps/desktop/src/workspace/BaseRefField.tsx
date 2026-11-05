import { Popover, SearchPicker, type SearchPickerItem } from "@xdev-asia/ui";
import { useState } from "react";
import type { JSX } from "react";
import type { ReviewBranch } from "@/api";
import { useI18n } from "@/i18n";
import { baseRefOptions } from "./createSource";

/**
 * The "Branch from" field of the create dialog: a button with the chosen ref that opens a search over
 * the repo's branches. The value is "" for the project default; any other text is a ref to start from.
 */
export function BaseRefField(props: {
  value: string;
  baseRef: string | null;
  /** The branches of the repo; null until they load. */
  branches: ReviewBranch[] | null;
  /** The branch list could not be read; a typed ref still works. */
  failed: boolean;
  onChange(ref: string): void;
}): JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { options, typed } = baseRefOptions(props.branches ?? [], props.baseRef, query);
  const defaultLabel = props.baseRef ? t("workspace.create.base.defaultNamed", { branch: props.baseRef }) : t("workspace.create.base.default");
  const shown = props.value === "" ? defaultLabel : props.value;

  const items: SearchPickerItem[] = [
    ...(typed !== null ? [{ id: "typed", title: t("workspace.create.base.useTyped", { ref: typed }) }] : []),
    ...options.map((o) => ({ id: o.isDefault ? "default" : `b:${o.name}`, title: o.isDefault ? defaultLabel : o.name })),
  ];
  const loading = props.branches === null && !props.failed;
  const status = loading ? t("workspace.create.base.loading") : props.failed ? t("workspace.create.base.failed") : items.length === 0 ? t("workspace.create.base.empty") : undefined;

  function close(): void {
    setOpen(false);
    setQuery("");
  }
  function pick(id: string): void {
    if (id === "default") props.onChange("");
    else if (id === "typed" && typed !== null) props.onChange(typed);
    else if (id.startsWith("b:")) props.onChange(id.slice(2));
    close();
  }

  return (
    <Popover
      open={open}
      onClose={close}
      placement="bottom-start"
      label={t("workspace.create.base.label")}
      className="ws-base-ref-pop"
      trigger={(triggerProps) => (
        <button type="button" className="ws-base-ref" aria-label={`${t("workspace.create.base.label")}: ${shown}`} {...triggerProps} onClick={() => setOpen(!open)}>
          {shown}
        </button>
      )}
    >
      <SearchPicker
        label={t("workspace.create.base.label")}
        placeholder={t("workspace.create.base.search")}
        value={query}
        onValueChange={setQuery}
        items={items}
        status={status}
        labels={{ clear: t("workspace.create.base.clear") }}
        onPick={pick}
      />
    </Popover>
  );
}
