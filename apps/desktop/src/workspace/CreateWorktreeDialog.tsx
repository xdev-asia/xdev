import { Button } from "@xdev/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { RepoView, WorkItem, WorkItemKind } from "@/api";
import { useI18n } from "@/i18n";
import { expandShortcodes, hasEmoji, slugFromTitle } from "./emoji";
import { parseItem } from "./workItemInput";

/** What the dialog adds to the name and base: the title, the agent, the parent and the work item. */
export type CreateExtra = { title: string | null; agent: string | null; setDefault: boolean; parent: string | null; item: WorkItem | null };

export type AgentChoice = { id: string; name: string };

type Form = {
  text: string;
  agent: string;
  defaultAgent: string | null;
  setDefault: boolean;
  parent: string;
  itemUrl: string;
  itemKind: WorkItemKind;
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
    },
  };
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
  onCreate(repoId: string, name: string, from: string | null, extra: CreateExtra): void;
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

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  // A repo whose folder is gone cannot take a new worktree.
  const choices = props.repos.filter((r) => !r.missing);
  const repo = choices.find((r) => r.id === repoId) ?? choices[0];
  // A parent is another worktree of the repo that is not the main checkout and not itself a child.
  const parents = (repo?.worktrees ?? []).filter((w) => !w.primary && w.parent === null);
  const parentPath = parents.some((w) => w.path === parent) ? parent : "";
  const badItem = parseItem(itemUrl, itemKind) === "bad";
  const offerDefault = agent !== "" && agent !== defaultAgent;

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
          const built = repo && buildCreate({ text: name, agent, defaultAgent, setDefault, parent: parentPath, itemUrl, itemKind });
          if (repo && built) props.onCreate(repo.id, built.name, from.trim() || null, built.extra);
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
          </label>
          <label className="ws-field">
            <span>{t("workspace.create.from")}</span>
            <input type="text" className="ws-mono" value={from} placeholder={repo?.baseRef ?? ""} spellCheck={false} onChange={(e) => setFrom(e.target.value)} />
          </label>
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
        </div>
        {badItem && (
          <p className="error-text" role="alert">
            {t("error.bad_item")}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn-secondary" onClick={props.onCancel}>
            {t("dialog.cancel")}
          </button>
          <Button type="submit" disabled={!repo || badItem}>
            {t("workspace.create.confirm")}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
