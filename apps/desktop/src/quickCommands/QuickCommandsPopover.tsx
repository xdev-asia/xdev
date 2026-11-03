import { useMemo, useState } from "react";
import type { JSX } from "react";
import type { FileCommands } from "@/api";
import { useI18n } from "@/i18n";
import { buildSections, flatRows, popoverKey, stepRow, type Env, type Row } from "./model";
import { QuickCommandsMenu } from "./QuickCommandsMenu";
import type { Selected } from "./store";

/** The tab a terminal command would be typed into, for the footer line. */
export interface RunTarget {
  name: string | null;
  agent: boolean;
}

export function QuickCommandsPopover(props: {
  sel: Selected;
  file: FileCommands | null;
  env: Env;
  repoName: string;
  target: RunTarget;
  onRun(row: Row, appendEnter?: false): void;
  onTrust(): void;
  onNew(): void;
  onManage(): void;
  onClose(): void;
}): JSX.Element {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const sections = useMemo(() => buildSections(props.sel, props.file, query, props.env), [props.sel, props.file, query, props.env]);
  const rows = flatRows(sections);
  // The row the keyboard is on: its key, so it survives a reload of the list.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const found = rows.findIndex((r) => r.key === activeKey);
  const active = found >= 0 ? found : rows.length === 0 ? -1 : stepRow(rows, -1, 1);
  const none = props.sel.global.length + props.sel.project.length + (props.file?.commands.length ?? 0) === 0;

  return (
    <div
      className="qc-popover"
      role="dialog"
      aria-label={t("qcmd.buttonLabel")}
      onKeyDown={(e) => {
        const res = popoverKey(rows, active, e.key, e.shiftKey);
        if (!res.effect && res.active === active) return;
        e.preventDefault();
        if (res.effect?.kind === "close") return props.onClose();
        if (res.effect?.kind === "run") return props.onRun(res.effect.row, res.effect.appendEnter);
        setActiveKey(rows[res.active]?.key ?? null);
      }}
    >
      {!none && (
        <input
          type="search"
          className="qc-search"
          aria-label={t("qcmd.search")}
          placeholder={t("qcmd.search")}
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      {none ? (
        <p className="qc-empty">{t("qcmd.empty")}</p>
      ) : sections.length === 0 ? (
        <p className="qc-empty">{t("qcmd.noMatch")}</p>
      ) : (
        <QuickCommandsMenu
          sections={sections}
          active={rows[active]?.key ?? null}
          repoName={props.repoName}
          t={t}
          onHover={(r) => setActiveKey(r.key)}
          onChoose={(r, shift) => props.onRun(r, shift && r.cmd.action.type === "terminal" ? false : undefined)}
          onTrust={props.onTrust}
        />
      )}
      <div className="qc-footer">
        <p className="qc-target" role="status">
          {props.target.name === null ? t("qcmd.runsInNone") : t("qcmd.runsIn", { tab: props.target.name })}
          {props.target.agent && <span className="qc-warn">{t("qcmd.agentTab")}</span>}
        </p>
        <div className="qc-actions">
          <button type="button" className="btn-secondary" onClick={props.onNew}>
            {t("qcmd.new")}
          </button>
          <button type="button" className="btn-secondary" onClick={props.onManage}>
            {t("qcmd.manage")}
          </button>
        </div>
      </div>
    </div>
  );
}
