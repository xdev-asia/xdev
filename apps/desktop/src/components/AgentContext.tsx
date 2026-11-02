import { Button } from "@xdev/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ExportFile, type ExportPlan } from "../api";
import type { Problem } from "../changes/useChanges";
import { docsFor, expectedOf, overLimit } from "../export/plan";
import { useI18n } from "../i18n";
import { COMPACT, ProblemNote } from "./ChangesPanel";
import { ConnectAgent } from "./ConnectAgent";
import { DiffView } from "./DiffView";

// What the agent files would look like if written now, compared with what is on disk.
export function AgentContext(props: {
  api: Api;
  // Bumped on every vault change: a doc edited anywhere can change the plan.
  revision: number;
  // The plan is built from disk, so unsaved edits are written first.
  flush(): Promise<boolean>;
  // Agents can also read the vault live over MCP; this is the folder they are pointed at.
  vaultPath: string;
  onOpenDoc(path: string): void;
}): JSX.Element {
  const { t } = useI18n();
  const { api, flush } = props;
  const [plan, setPlan] = useState<ExportPlan>();
  const [selected, setSelected] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem>();
  const [written, setWritten] = useState<number>();
  const [writing, setWriting] = useState(false);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let stale = false;
    void (async () => {
      const saved = await flush();
      try {
        const next = await api.exportPlan();
        if (stale) return;
        setPlan(next);
        setProblem((p) => (!saved ? { code: "unsaved" } : p?.code === "unsaved" ? undefined : p));
      } catch (e) {
        if (!stale) setProblem(toApiError(e));
      }
    })();
    return () => {
      stale = true;
    };
  }, [api, flush, props.revision, reloads]);

  async function write() {
    if (plan === undefined) return;
    setWriting(true);
    setProblem(undefined);
    setWritten(undefined);
    try {
      setWritten((await api.exportWrite(expectedOf(plan))).length);
    } catch (e) {
      // `stale` included: the reload below shows the new preview, which the message asks to check.
      setProblem(toApiError(e));
    } finally {
      setWriting(false);
      setReloads((n) => n + 1);
    }
  }

  const file = plan?.files.find((f) => f.path === selected) ?? plan?.files[0];
  const pending = plan === undefined ? 0 : expectedOf(plan).length;
  return (
    <div className="agentctx">
      <div className="agentctx-head">
        <div className="doc-titles">
          <h1 className="doc-title">{t("agents.title")}</h1>
          {plan && <span className="doc-path">{t("agents.root", { path: plan.root })}</span>}
        </div>
        <div className="doc-actions">
          {written !== undefined && (
            <span className="doc-status" role="status">
              {t("agents.written", { count: written })}
            </span>
          )}
          <Button type="button" style={COMPACT} disabled={writing || pending === 0} onClick={() => void write()}>
            {writing ? t("agents.writing") : t("agents.write", { count: pending })}
          </Button>
        </div>
      </div>
      <ConnectAgent vaultPath={props.vaultPath} />
      {problem && <ProblemNote problem={problem} />}
      {plan === undefined ? (
        !problem && <p className="placeholder">{t("agents.loading")}</p>
      ) : plan.docs.length === 0 && plan.files.length === 0 ? (
        <div className="placeholder">
          <p>{t("agents.empty")}</p>
          <p>{t("agents.emptyHint", { checkbox: t("doc.agents") })}</p>
        </div>
      ) : (
        <div className="history">
          <section className="history-side" aria-label={t("agents.files")}>
            <div className="pane-head">
              <span>{t("agents.files")}</span>
            </div>
            <ul className="history-list">
              {plan.files.map((f) => (
                <li key={f.path}>
                  <button
                    type="button"
                    className="history-item agentctx-file"
                    aria-current={f.path === file?.path ? "true" : undefined}
                    onClick={() => setSelected(f.path)}
                  >
                    <code className="history-message">{f.path}</code>
                    <span className="badge" data-status={f.status}>
                      {t(`agents.status.${f.status}`)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="pane-head agentctx-docs-head">
              <span>{t("agents.docs")}</span>
              <span className="pane-count">{plan.docs.length}</span>
            </div>
            {plan.docs.length === 0 ? (
              <p className="pane-empty">{t("agents.empty")}</p>
            ) : (
              <ul className="history-list">
                {plan.docs.map((d) => (
                  <li key={d.path}>
                    <button type="button" className="history-item" title={d.path} onClick={() => props.onOpenDoc(d.path)}>
                      <span className="history-message">{d.title}</span>
                      <span className="badges">
                        {d.targets.map((target) => (
                          <span key={target} className="badge">
                            {t(`target.${target}`)}
                          </span>
                        ))}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <div className="history-main">
            {file === undefined ? (
              <p className="placeholder">{t("agents.noFiles")}</p>
            ) : (
              <FileDetail plan={plan} file={file} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function FileDetail(props: { plan: ExportPlan; file: ExportFile }): JSX.Element {
  const { t } = useI18n();
  const { plan, file } = props;
  const sources = docsFor(plan, file.path);
  const isAgents = file.path === "AGENTS.md";
  return (
    <>
      <div className="history-head">
        <code className="history-message">{file.path}</code>
        {isAgents && <span className="agentctx-tokens">{t("agents.tokens", { count: plan.tokens })}</span>}
      </div>
      {isAgents && overLimit(file) && (
        <div className="banner banner-warn" role="alert">
          <span className="banner-text">{t("agents.tooLarge")}</span>
        </div>
      )}
      {file.status === "foreign" && <p className="diff-note">{t("agents.foreign")}</p>}
      {file.status === "unchanged" && <p className="diff-note">{t("agents.unchanged")}</p>}
      {sources.length > 0 && (
        <p className="diff-note">{t("agents.from", { docs: sources.map((d) => d.title).join(", ") })}</p>
      )}
      <DiffView base={file.old ?? ""} current={file.new} />
    </>
  );
}
