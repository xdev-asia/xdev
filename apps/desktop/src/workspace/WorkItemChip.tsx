import type { JSX } from "react";
import type { WorkItem } from "@/api";
import { useI18n } from "@/i18n";
import { itemLabel } from "./sidebarModel";

/** The link of a worktree's pull request or issue; a click copies the URL (the app opens no links). */
export function WorkItemChip(props: { item: WorkItem; onCopy(url: string): void }): JSX.Element {
  const { t } = useI18n();
  const { item } = props;
  const kind = t(`workItem.kind.${item.kind}`);
  // A span with a button role: it sits inside the row's own button, which cannot hold another.
  return (
    <span
      className="ws-pr ws-item"
      role="button"
      tabIndex={0}
      data-kind={item.kind}
      title={t("workItem.copy", { kind, url: item.url })}
      aria-label={t("workItem.copy", { kind, url: item.url })}
      onClick={(e) => {
        e.stopPropagation();
        props.onCopy(item.url);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        props.onCopy(item.url);
      }}
    >
      {itemLabel(item)}
    </span>
  );
}
