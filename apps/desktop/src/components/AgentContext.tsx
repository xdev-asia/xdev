import { Button } from "@xdev/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ExportFile, type ExportPlan } from "../api";
import type { Problem } from "../changes/useChanges";
import { docsFor, expectedOf, overLimit } from "../export/plan";
import { useI18n } from "../i18n";
import { COMPACT, ICON, Icon, ProblemNote } from "./ChangesPanel";
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
  // Undefined until asked; null when the CLI is not beside the app.
  const [cliPath, setCliPath] = useState<string | null>();

  useEffect(() => {
    let stale = false;
    api.cliPath().then(
      (path) => !stale && setCliPath(path),
      () => !stale && setCliPath(null),
    );
    return () => {
      stale = true;
    };
  }, [api]);

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
        <h1 className="agentctx-title">{t("agents.title")}</h1>
        {plan && <p className="agentctx-root">{t("agents.root", { path: plan.root })}</p>}
      </div>
      {problem && <ProblemNote problem={problem} />}
      {plan === undefined ? (
        !problem && <p className="placeholder">{t("agents.loading")}</p>
      ) : plan.docs.length === 0 && plan.files.length === 0 ? (
        <div className="placeholder">
          <p>{t("agents.empty")}</p>
          <p>{t("agents.emptyHint", { checkbox: t("doc.agents") })}</p>
        </div>
      ) : (
        <div className="agentctx-body">
          <div className="agentctx-side">
            <section className="agentctx-group" aria-label={t("agents.files")}>
              <h2 className="agentctx-label">{t("agents.files")}</h2>
              <ul className="agentctx-list">
                {plan.files.map((f) => (
                  <li key={f.path}>
                    <button
                      type="button"
                      className="agentctx-file"
                      aria-current={f.path === file?.path ? "true" : undefined}
                      onClick={() => setSelected(f.path)}
                    >
                      <span className="agentctx-file-row">
                        <Icon d={ICON.doc} size={15} />
                        <code className="agentctx-file-path">{f.path}</code>
                        <span className="badge" data-status={f.status}>
                          {t(`agents.status.${f.status}`)}
                        </span>
                      </span>
                      {f.path === "AGENTS.md" && (
                        <span className="agentctx-file-tokens">{t("agents.tokens", { count: plan.tokens })}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
            <section className="agentctx-group" aria-label={t("agents.docs")}>
              <h2 className="agentctx-label">
                {t("agents.docs")}
                <span className="agentctx-count">{plan.docs.length}</span>
              </h2>
              {plan.docs.length === 0 ? (
                <p className="pane-empty">{t("agents.empty")}</p>
              ) : (
                <ul className="agentctx-docs">
                  {plan.docs.map((d) => (
                    <li key={d.path}>
                      <button type="button" className="agentctx-doc" title={d.path} onClick={() => props.onOpenDoc(d.path)}>
                        <span className="agentctx-doc-row">
                          <span className="agentctx-doc-title">{d.title}</span>
                          <span className="badges">
                            {d.targets.map((target) => (
                              <span key={target} className="badge" data-target={target}>
                                {t(`target.${target}`)}
                              </span>
                            ))}
                          </span>
                        </span>
                        <code className="agentctx-doc-path">{d.path}</code>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <div className="agentctx-write">
              <Button
                type="button"
                className="changes-approve-all agentctx-write-btn"
                style={COMPACT}
                disabled={writing || pending === 0}
                onClick={() => void write()}
              >
                <Icon d={ICON.download} />
                {writing ? t("agents.writing") : t("agents.write", { count: pending })}
              </Button>
              {written !== undefined && (
                <span className="agentctx-written" role="status">
                  <Icon d={ICON.check} />
                  {t("agents.written", { count: written })}
                </span>
              )}
            </div>
          </div>
          <section className="agentctx-preview" aria-label={file?.path ?? t("agents.files")}>
            {file === undefined ? (
              <p className="placeholder">{t("agents.noFiles")}</p>
            ) : (
              <FileDetail plan={plan} file={file} />
            )}
          </section>
        </div>
      )}
      <ConnectAgent vaultPath={props.vaultPath} cliPath={cliPath} />
    </div>
  );
}

function FileDetail(props: { plan: ExportPlan; file: ExportFile }): JSX.Element {
  const { t } = useI18n();
  const { plan, file } = props;
  const sources = docsFor(plan, file.path);
  const isAgents = file.path === "AGENTS.md";
  return (
    <div className="agentctx-card">
      <div className="agentctx-card-head">
        <div className="agentctx-card-title">
          <code className="agentctx-card-path">{file.path}</code>
          <span className="badge" data-status={file.status}>
            {t(`agents.status.${file.status}`)}
          </span>
        </div>
        {sources.length > 0 && (
          <p className="agentctx-from">{t("agents.from", { docs: sources.map((d) => d.title).join(", ") })}</p>
        )}
      </div>
      {isAgents && overLimit(file) && (
        <div className="agentctx-alert" data-tone="warn" role="alert">
          <Icon d={ICON.warn} />
          <span>{t("agents.tooLarge")}</span>
        </div>
      )}
      {file.status === "foreign" && (
        <div className="agentctx-alert" data-tone="foreign">
          <Icon d={ICON.lock} size={18} />
          <span>{t("agents.foreign")}</span>
        </div>
      )}
      {file.status === "unchanged" && (
        <p className="agentctx-unchanged">
          <Icon d={ICON.check} />
          {t("agents.unchanged")}
        </p>
      )}
      <DiffView base={file.old ?? ""} current={file.new} />
    </div>
  );
}
