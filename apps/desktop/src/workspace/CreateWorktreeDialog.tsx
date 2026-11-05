import { Button, Disclosure, RadioGroup, Segmented, Switch } from "@xdev-asia/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError, type CreateRequest, type Issue, type NamePreview, type PrSummary, type ReviewBranch, type RepoView, type WorkItem, type WorkItemKind } from "@/api";
import { isIssueRef } from "@/issues/issueStart";
import { useI18n } from "@/i18n";
import { expandShortcodes, hasEmoji, slugFromTitle } from "./emoji";
import { localBranches, sparseDirs } from "./createSource";
import { LinkedWorkSearch } from "./LinkedWorkSearch";
import { schedulePreview } from "./namePreview";
import { BaseRefField } from "./BaseRefField";
import { parseItem } from "./workItemInput";

/** What the dialog adds to the name and base: the title, the agent, the parent and the work item. */
export type CreateExtra = { title: string | null; agent: string | null; setDefault: boolean; parent: string | null; item: WorkItem | null; /** Becomes the comment of the worktree. */ note?: string | null; /** Typed into the agent that opens, once it has started. */ prompt?: string };

/** How long the name field rests before an issue number with a hash, or an issue URL, is looked up. */
export const ISSUE_RESOLVE_DEBOUNCE_MS = 300;

type Found = { repoId: string; text: string; issue: Issue | null; error?: ApiError["code"] };

export type CreateTab = "name" | "github" | "branch";

export type AgentChoice = { id: string; name: string };

type Form = {
  text: string;
  agent: string;
  defaultAgent: string | null;
  setDefault: boolean;
  parent: string;
  itemUrl: string;
  itemKind: WorkItemKind;
  note?: string;
};

/** The name for `worktree_create` and the extras; null while the work item link is unusable. */
export function buildCreate(form: Form): { name: string; extra: CreateExtra } | null {
  const item = parseItem(form.itemUrl, form.itemKind);
  if (item === "bad") return null;
  const text = form.text.trim();
  // A name without emoji goes as typed, so slashes still reach the name rules of the backend.
  const named = hasEmoji(text);
  const agent = form.agent === "" ? null : form.agent;
  return {
    name: named ? slugFromTitle(text) : text,
    extra: {
      title: named ? text : null,
      agent,
      setDefault: form.setDefault && agent !== null && agent !== form.defaultAgent,
      parent: form.parent === "" ? null : form.parent,
      item,
      ...(form.note && form.note.trim() !== "" ? { note: form.note.trim() } : {}),
    },
  };
}

/** "Will be created as `folder` on branch `branch`", only when a taken name got a suffix. */
export function PreviewHint(props: { preview: NamePreview | null }): JSX.Element | null {
  const { t } = useI18n();
  const { preview } = props;
  if (!preview?.suffixed) return null;
  return (
    <small role="status" data-preview>
      {t("createWorktree.preview.willBe", { folder: preview.folder, branch: preview.branch })}
    </small>
  );
}

// Mounted only while open, so every opening starts from blank fields.
export function CreateWorktreeDialog(props: {
  repos: RepoView[];
  repoId: string;
  /** The agents that can start in the new worktree. */
  agents?: AgentChoice[];
  /** The agent profile new worktrees start with. */
  defaultAgent?: string | null;
  /** A name to start with, such as one typed into the jump palette. */
  name?: string;
  /** The name a create would get; without it no preview shows. */
  namePreview?(repoId: string, name: string): Promise<NamePreview>;
  /** `more` is true when Create more is on: the shell leaves the dialog open and the dialog blanks its name. */
  onCreate(repoId: string, name: string, from: string | null, extra: CreateExtra, request?: CreateRequest, more?: boolean): void;
  /** Reads the issue a an issue number with a hash, or an issue URL, in the name field points to. */
  resolveIssue?(repoId: string, text: string): Promise<Issue | null>;
  /** Create with an issue in the name field: the shell starts the worktree from it instead of `onCreate`. */
  onStartIssue?(repoId: string, issue: Issue): void;
  /** Searches issues and pull requests for the GitHub tab; without it there is no such tab. */
  api?: Api;
  /** A pull request picked on the GitHub tab: the shell starts the worktree from it. */
  onStartPr?(repoId: string, pr: PrSummary): void;
  /** The tab to open on, and told when it changes, so the next opening comes back to it. */
  initialTab?: CreateTab;
  onTabChange?(tab: CreateTab): void;
  /** The branches of a repo checkout, for the Branch tab. */
  branches?(repoPath: string): Promise<ReviewBranch[]>;
  onCancel(): void;
}): JSX.Element {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const agents = props.agents ?? [];
  const defaultAgent = props.defaultAgent ?? null;
  const [repoId, setRepoId] = useState(props.repoId);
  const [name, setName] = useState(expandShortcodes(props.name ?? ""));
  const [from, setFrom] = useState("");
  // Until one is picked, the default agent, which may arrive after the dialog opens.
  const [picked, setAgent] = useState<string | null>(null);
  const agent = picked ?? (agents.some((a) => a.id === defaultAgent) ? (defaultAgent ?? "") : "");
  const [setDefault, setSetDefault] = useState(false);
  const [parent, setParent] = useState("");
  const [itemUrl, setItemUrl] = useState("");
  const [itemKind, setItemKind] = useState<WorkItemKind>("pr");
  const [note, setNote] = useState("");
  const [sparseText, setSparseText] = useState("");
  const [more, setMore] = useState(false);
  const [tab, setTab] = useState<CreateTab>(props.initialTab ?? "name");
  const [branchMode, setBranchMode] = useState<"new" | "existing">("new");
  const [branchList, setBranchList] = useState<{ repoId: string; list: ReviewBranch[] } | null>(null);
  const [existing, setExisting] = useState("");
  const [listFailed, setListFailed] = useState<string | null>(null);
  const [found, setFound] = useState<Found | null>(null);
  const [preview, setPreview] = useState<NamePreview | null>(null);

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  // A repo whose folder is gone cannot take a new worktree.
  const choices = props.repos.filter((r) => !r.missing);
  const repo = choices.find((r) => r.id === repoId) ?? choices[0];
  // The name as Create would send it, so the preview matches what is made.
  const sent = hasEmoji(name.trim()) ? slugFromTitle(name.trim()) : name.trim();
  const { namePreview } = props;
  useEffect(() => {
    if (!namePreview) return;
    return schedulePreview(namePreview, repo?.id ?? "", sent, setPreview);
  }, [namePreview, repo?.id, sent]);
  // A parent is another worktree of the repo that is not the main checkout and not itself a child.
  const parents = (repo?.worktrees ?? []).filter((w) => !w.primary && w.parent === null);
  const parentPath = parents.some((w) => w.path === parent) ? parent : "";
  const badItem = parseItem(itemUrl, itemKind) === "bad";
  const { branches } = props;
  // The Branch tab always picks an existing branch; on the Name tab the choice is the radio.
  const mode = tab === "branch" ? "existing" : branchMode;
  const listing = tab !== "github" && mode === "existing";
  // The base picker lists the branches too, so they load for it as well, once per repo.
  const baseShown = mode !== "existing";
  useEffect(() => {
    if (!(listing || baseShown) || !branches || !repo) return;
    let stale = false;
    branches(repo.path).then(
      (list) => !stale && setBranchList({ repoId: repo.id, list }),
      () => {
        if (stale) return;
        setBranchList({ repoId: repo.id, list: [] });
        setListFailed(repo.id);
      },
    );
    return () => {
      stale = true;
    };
  }, [listing || baseShown, branches, repo?.id]);
  const loaded = branchList && branchList.repoId === repo?.id ? branchList.list : null;
  const free = loaded && repo ? localBranches(loaded, repo.worktrees) : [];
  const pickedBranch = listing && free.includes(existing) ? existing : "";
  const needsBranch = listing && pickedBranch === "";
  const sparse = sparseDirs(sparseText);
  const badSparse = sparse === "bad";
  const ref = props.resolveIssue !== undefined && props.onStartIssue !== undefined && isIssueRef(name);
  const refText = name.trim();
  const refRepo = repo?.id ?? "";
  const resolved = found && found.repoId === refRepo && found.text === refText ? found : null;
  const issue = ref ? (resolved?.issue ?? null) : null;
  const offerDefault = agent !== "" && agent !== defaultAgent;

  // an issue number with a hash, or an issue URL, is looked up once typing rests; a result for older text is ignored.
  useEffect(() => {
    if (!ref || !props.resolveIssue || refRepo === "") return;
    let stale = false;
    const resolve = props.resolveIssue;
    const timer = setTimeout(() => {
      resolve(refRepo, refText).then(
        (issue) => !stale && setFound({ repoId: refRepo, text: refText, issue, ...(issue ? {} : { error: "issue_not_found" as const }) }),
        (e: unknown) => !stale && setFound({ repoId: refRepo, text: refText, issue: null, error: toApiError(e).code }),
      );
    }, ISSUE_RESOLVE_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [ref, refRepo, refText]);

  function submit(): void {
    if (ref) {
      if (repo && issue) props.onStartIssue?.(repo.id, issue);
      return;
    }
    if (tab === "github" || badItem || badSparse || needsBranch) return;
    const built = repo && buildCreate({ text: name.trim() === "" && pickedBranch !== "" ? pickedBranch.replace(/[\/]+/g, "-") : name, agent, defaultAgent, setDefault, parent: parentPath, itemUrl, itemKind, note });
    if (!repo || !built) return;
    const dirs = Array.isArray(sparse) ? sparse : [];
    const request: CreateRequest | undefined = pickedBranch !== "" || dirs.length > 0 ? { existing: pickedBranch || null, sparse: dirs } : undefined;
    props.onCreate(repo.id, built.name, pickedBranch !== "" ? null : from.trim() || null, built.extra, request, more);
    if (more) {
      setName("");
      setNote("");
    }
  }

  return (
    <dialog
      ref={dialog}
      className="dialog ws-dialog"
      aria-labelledby="ws-create-title"
      onCancel={(e) => {
        e.preventDefault();
        props.onCancel();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            submit();
          }
        }}
      >
        <h2 id="ws-create-title" className="dialog-title">
          {t("workspace.create.title")}
        </h2>
        <p className="dialog-body">{t("workspace.create.body")}</p>
        <div className="ws-fields">
          <label className="ws-field">
            <span>{t("workspace.create.repo")}</span>
            <select value={repo?.id ?? ""} onChange={(e) => setRepoId(e.target.value)}>
              {choices.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.shortName}
                </option>
              ))}
            </select>
          </label>
          <Segmented
            label={t("workspace.create.tab.label")}
            value={tab}
            onChange={(v) => {
              setTab(v as CreateTab);
              props.onTabChange?.(v as CreateTab);
            }}
            options={[
              { value: "name", label: t("workspace.create.tab.name") },
              ...(props.api && props.onStartIssue && props.onStartPr ? [{ value: "github", label: t("workspace.create.tab.github") }] : []),
              ...(branches ? [{ value: "branch", label: t("workspace.create.tab.branch") }] : []),
            ]}
          />
          {tab === "github" && props.api && repo && (
            <div className="ws-field">
              <LinkedWorkSearch
                api={props.api}
                repoId={repo.id}
                onPick={(_item, source) => {
                  if (source?.kind === "issue") props.onStartIssue?.(repo.id, source.issue);
                  else if (source?.kind === "pr") props.onStartPr?.(repo.id, source.pr);
                }}
              />
              <small>{t("workspace.create.searchHint")}</small>
            </div>
          )}
          {tab !== "github" && branches && (
            <div className="ws-field">
              {tab === "name" && (
                <RadioGroup
                  name="ws-create-branch-mode"
                  label={t("workspace.create.branchMode.label")}
                  value={branchMode}
                  onChange={(v) => setBranchMode(v as "new" | "existing")}
                  options={[
                    { value: "new", label: t("workspace.create.branchMode.new") },
                    { value: "existing", label: t("workspace.create.branchMode.existing") },
                  ]}
                />
              )}
              {mode === "existing" &&
                (loaded !== null && free.length === 0 ? (
                  <small role="status">{t("workspace.create.noBranches")}</small>
                ) : (
                  <select aria-label={t("workspace.create.branchMode.existing")} className="ws-mono" value={pickedBranch} onChange={(e) => setExisting(e.target.value)}>
                    <option value="">{t("workspace.create.pickBranch")}</option>
                    {free.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                ))}
            </div>
          )}
          <label className="ws-field">
            <span>{t("workspace.create.name")}</span>
            <input
              type="text"
              value={name}
              placeholder={t("workspace.create.namePlaceholder")}
              spellCheck={false}
              autoFocus
              aria-describedby="ws-create-hint"
              onChange={(e) => setName(expandShortcodes(e.target.value))}
            />
            <small id="ws-create-hint">{t("workspace.create.nameHint")}</small>
            {ref && (
              <small className={resolved?.error ? "error-text" : undefined} role={resolved?.error ? "alert" : "status"}>
                {issue ? t("workspace.create.issueFound", { number: issue.number, title: issue.title }) : resolved?.error ? t(`error.${resolved.error}`) : t("workspace.create.issueLooking")}
              </small>
            )}
            <PreviewHint preview={preview} />
          </label>
          {pickedBranch === "" && mode !== "existing" && (
            <div className="ws-field">
              <span>{t("workspace.create.base.label")}</span>
              <BaseRefField value={from} baseRef={repo?.baseRef ?? null} branches={branches ? loaded : []} failed={listFailed === repo?.id} onChange={setFrom} />
            </div>
          )}
          <label className="ws-field">
            <span>{t("workspace.create.agent")}</span>
            <select value={agent} onChange={(e) => setAgent(e.target.value)}>
              <option value="">{t("workspace.create.noAgent")}</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          {offerDefault && (
            <label className="ws-tick">
              <input type="checkbox" checked={setDefault} onChange={(e) => setSetDefault(e.target.checked)} />
              <span>{t("workspace.create.setDefault")}</span>
            </label>
          )}
          <div className="ws-field">
            <span>{t("workspace.create.item")}</span>
            <div className="ws-item-row">
              <select aria-label={t("workspace.create.itemKind")} value={itemKind} onChange={(e) => setItemKind(e.target.value as WorkItemKind)}>
                <option value="pr">{t("workItem.kind.pr")}</option>
                <option value="issue">{t("workItem.kind.issue")}</option>
              </select>
              <input
                type="text"
                className="ws-mono"
                value={itemUrl}
                placeholder={t("workspace.create.itemPlaceholder")}
                spellCheck={false}
                aria-invalid={badItem}
                onChange={(e) => setItemUrl(e.target.value)}
              />
            </div>
          </div>
          <Disclosure title={t("workspace.create.advanced")} defaultExpanded={false}>
            <div className="ws-fields">
            {parents.length > 0 && (
              <label className="ws-field">
                <span>{t("workspace.create.parent")}</span>
                <select value={parentPath} onChange={(e) => setParent(e.target.value)}>
                  <option value="">{t("workspace.create.noParent")}</option>
                  {parents.map((w) => (
                    <option key={w.path} value={w.path}>
                      {w.title ?? w.branch ?? w.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
              <label className="ws-field">
                <span>{t("workspace.create.note")}</span>
                <textarea value={note} rows={2} placeholder={t("workspace.create.notePlaceholder")} onChange={(e) => setNote(e.target.value)} />
              </label>
              <label className="ws-field">
                <span>{t("workspace.create.sparse")}</span>
                <textarea
                  className="ws-mono"
                  value={sparseText}
                  rows={3}
                  spellCheck={false}
                  aria-invalid={badSparse}
                  aria-describedby="ws-create-sparse-hint"
                  onChange={(e) => setSparseText(e.target.value)}
                />
                <small id="ws-create-sparse-hint">{Array.isArray(sparse) && sparse.length > 0 ? t("workspace.create.sparseHint") : t("workspace.create.sparseFull")}</small>
              </label>
            </div>
          </Disclosure>
        </div>
        {(badItem || badSparse) && (
          <p className="error-text" role="alert">
            {badItem ? t("error.bad_item") : t("error.bad_sparse")}
          </p>
        )}
        <div className="dialog-actions">
          <Switch label={t("workspace.create.createMore")} checked={more} onChange={(e) => setMore(e.target.checked)} />
          <button type="button" className="btn-secondary" onClick={props.onCancel}>
            {t("dialog.cancel")}
          </button>
          <Button type="submit" disabled={!repo || tab === "github" || badItem || badSparse || needsBranch || (ref && !issue)}>
            {t("workspace.create.confirm")}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
