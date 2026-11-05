import { Button, CodeBlock, Select } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type FileText, type RepoView } from "@/api";
import { useI18n } from "@/i18n";
import { MCP_FILE, entrySnippet, mergeEntry, xdevEntry, type MergeResult } from "./mcpEntry";

type Plan = { repo: RepoView; file: FileText | null; merge: MergeResult };
type Done = "added" | "same";

/**
 * Adds the xdev server to a repo's `.mcp.json`. Choosing "Preview" reads the file and shows the entry;
 * nothing is written until "Add" is pressed. Other servers in the file are kept, and a file that is not
 * valid JSON is never touched.
 */
export function McpAddToRepo(props: { api: Pick<Api, "workspaceList" | "fileRead" | "fileWrite">; cliPath: string | null }): JSX.Element {
  const { api, cliPath } = props;
  const { t } = useI18n();
  const [repos, setRepos] = useState<RepoView[] | null>(null);
  const [repoId, setRepoId] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<Done>();

  useEffect(() => {
    let live = true;
    api.workspaceList().then(
      (list) => {
        if (!live) return;
        setRepos(list);
        setRepoId((current) => current || list[0]?.id || "");
      },
      (e: unknown) => {
        if (!live) return;
        setRepos([]);
        setError(toApiError(e).code);
      },
    );
    return () => {
      live = false;
    };
  }, [api]);

  const entry = xdevEntry(cliPath);

  async function preview(): Promise<void> {
    const repo = repos?.find((r) => r.id === repoId);
    if (!repo) return;
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    try {
      let file: FileText | null = null;
      try {
        file = await api.fileRead(repo.path, MCP_FILE);
      } catch (e) {
        if (toApiError(e).code !== "not_found") throw e;
      }
      // A file too large or binary to read is as unsafe to merge into as broken JSON.
      const merge: MergeResult = file !== null && file.text === null ? { status: "invalid" } : mergeEntry(file?.text ?? null, entry);
      setPlan({ repo, file, merge });
    } catch (e) {
      setPlan(null);
      setError(toApiError(e).code);
    } finally {
      setBusy(false);
    }
  }

  async function write(): Promise<void> {
    if (!plan || plan.merge.status !== "write") return;
    setBusy(true);
    setError(undefined);
    try {
      // `expected` is the hash we read, or null for no file: a file changed meanwhile is never overwritten.
      const out = await api.fileWrite(plan.repo.path, MCP_FILE, plan.merge.text, plan.file?.eol ?? "lf", plan.file?.hash ?? null);
      if (out.type === "saved") {
        setDone("added");
        setPlan(null);
      } else {
        setError("mcp_changed");
      }
    } catch (e) {
      setError(toApiError(e).code);
    } finally {
      setBusy(false);
    }
  }

  const options = (repos ?? []).map((r) => ({ value: r.id, label: r.shortName }));
  const merge = plan?.merge;

  return (
    <div className="mcp-add">
      <p className="settings-hint">{t("settings.mcp.add.hint", { file: MCP_FILE })}</p>
      {repos !== null && repos.length === 0 ? (
        <p className="settings-hint">{t("settings.mcp.add.noRepos")}</p>
      ) : (
        <div className="mcp-add-pick">
          <label className="ws-field">
            <span>{t("settings.mcp.add.repo")}</span>
            <Select
              data-field="mcpRepo"
              value={repoId}
              options={options}
              disabled={busy || repos === null}
              onChange={(e) => {
                setRepoId(e.target.value);
                setPlan(null);
                setDone(undefined);
                setError(undefined);
              }}
            />
          </label>
          <Button type="button" variant="secondary" data-act="mcp-preview" disabled={busy || !repoId} onClick={() => void preview()}>
            {t("settings.mcp.add.preview")}
          </Button>
        </div>
      )}
      {plan && merge && (
        <div className="mcp-preview" data-preview="mcp">
          <p>{t("settings.mcp.add.entry", { file: MCP_FILE, repo: plan.repo.shortName })}</p>
          <CodeBlock code={entrySnippet(entry)} language={MCP_FILE} labels={{ copy: t("settings.mcp.copyEntry"), copied: t("settings.mcp.copied") }} />
          {merge.status === "write" && (
            <p className="settings-hint" data-note="merge">
              {t(merge.replaces ? "settings.mcp.add.replaces" : merge.existing ? "settings.mcp.add.merges" : "settings.mcp.add.creates", { file: MCP_FILE })}
            </p>
          )}
          {merge.status === "same" && <p className="settings-hint">{t("settings.mcp.add.same", { file: MCP_FILE })}</p>}
          {merge.status === "invalid" && (
            <p className="error-text" role="alert" data-note="invalid">
              {t("settings.mcp.add.invalid", { file: MCP_FILE })}
            </p>
          )}
          <div className="settings-actions settings-actions-start">
            {merge.status === "write" && (
              <Button type="button" data-act="mcp-write" disabled={busy} onClick={() => void write()}>
                {t("settings.mcp.add.confirm", { file: MCP_FILE })}
              </Button>
            )}
            <Button type="button" variant="secondary" data-act="mcp-cancel" disabled={busy} onClick={() => setPlan(null)}>
              {t(merge.status === "write" ? "settings.mcp.add.cancel" : "settings.mcp.add.close")}
            </Button>
          </div>
        </div>
      )}
      <p role="status" className="settings-hint" data-status="mcp-add">
        {done === "added" ? t("settings.mcp.add.added", { file: MCP_FILE }) : ""}
      </p>
      {error && (
        <p className="error-text" role="alert">
          {t(`error.${error}`)}
        </p>
      )}
    </div>
  );
}
