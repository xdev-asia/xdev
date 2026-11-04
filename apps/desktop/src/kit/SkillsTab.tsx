import { Button } from "@xdev-asia/ui";
import { useEffect, useMemo, useState } from "react";
import type { FormEvent, JSX } from "react";
import type { Api, Home, Skill } from "@/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useI18n } from "@/i18n";
import { KitError, kitErr, type KitErr } from "./KitError";
import { displayPath, homeLabel, oneLine, scopeKey, scopeLabel, skillTargets, type SkillTarget } from "./kitUi";

const DESCRIPTION_MAX = 90;
const TOAST_MS = 10_000;

/** The skills as a table: one row each, with the actions for that skill. */
export function SkillTable(props: {
  skills: Skill[];
  homes: Home[];
  onOpen(skill: Skill): void;
  onCopy(skill: Skill): void;
  onRemove(skill: Skill): void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <table className="kit-table kit-skills">
      <thead>
        <tr>
          <th scope="col">{t("kit.skills.col.name")}</th>
          <th scope="col">{t("kit.skills.col.description")}</th>
          <th scope="col">{t("kit.skills.col.scope")}</th>
          <th scope="col">{t("kit.skills.col.home")}</th>
          <th scope="col" className="kit-num">{t("kit.skills.col.tokens")}</th>
          <th scope="col"><span className="kit-sr">{t("kit.skills.col.actions")}</span></th>
        </tr>
      </thead>
      <tbody>
        {props.skills.map((skill) => (
          <tr key={skill.dir} data-skill={skill.name}>
            <td className="kit-name">
              {skill.duplicate && <span className="kit-dot" data-dot="duplicate" role="img" aria-label={t("kit.skills.duplicate")} title={t("kit.skills.duplicate")} />}
              {skill.name}
            </td>
            <td className="kit-cut" title={skill.description}>{oneLine(skill.description, DESCRIPTION_MAX)}</td>
            <td><span className="kit-chip" data-scope={scopeKey(skill)}>{scopeLabel(skill, t)}</span></td>
            <td>{homeLabel(props.homes, skill.home_id, t)}</td>
            <td className="kit-num">{t("kit.tokens", { count: skill.tokens })}</td>
            <td className="kit-actions">
              <button type="button" className="kit-link" data-action="open" onClick={() => props.onOpen(skill)}>{t("kit.skills.open")}</button>
              <button type="button" className="kit-link" data-action="copy" onClick={() => props.onCopy(skill)}>{t("kit.skills.copy")}</button>
              <button type="button" className="kit-link" data-action="remove" onClick={() => props.onRemove(skill)}>{t("kit.skills.remove")}</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface Toast {
  text: string;
  undo?: () => void;
}

/** A line under the tab that says what just happened, with an Undo when there is one. */
function ToastLine(props: { toast: Toast; onClose(): void }): JSX.Element {
  const { t } = useI18n();
  const { toast, onClose } = props;
  useEffect(() => {
    const timer = setTimeout(onClose, TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);
  return (
    <div className="kit-toast" role="status">
      <span>{toast.text}</span>
      {toast.undo && (
        <button type="button" className="kit-link" data-action="undo" onClick={toast.undo}>
          {t("kit.skills.undo")}
        </button>
      )}
      <button type="button" className="kit-link" aria-label={t("kit.dismiss")} onClick={onClose}>
        ×
      </button>
    </div>
  );
}

/** Folder of a path: everything before the last separator. */
const parentOf = (path: string) => path.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]*$/, "");

export function SkillsTab(props: { api: Api; worktree: string | null }): JSX.Element {
  const { t } = useI18n();
  const { api, worktree } = props;
  const [skills, setSkills] = useState<Skill[]>();
  const [homes, setHomes] = useState<Home[]>([]);
  const [error, setError] = useState<KitErr>();
  const [homeFilter, setHomeFilter] = useState("");
  const [scopeFilter, setScopeFilter] = useState("");
  const [query, setQuery] = useState("");
  const [removing, setRemoving] = useState<Skill | null>(null);
  const [copying, setCopying] = useState<{ skill: Skill; target: string } | null>(null);
  const [adding, setAdding] = useState<{ name: string; description: string; target: string } | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let stale = false;
    void (async () => {
      try {
        const [list, h] = await Promise.all([api.kitSkills(worktree), api.kitHomes()]);
        if (stale) return;
        setSkills(list);
        setHomes(h);
        setError(undefined);
      } catch (e) {
        if (!stale) setError(kitErr(e));
      }
    })();
    return () => {
      stale = true;
    };
  }, [api, worktree, reloads]);

  const reload = () => setReloads((n) => n + 1);
  const targets = useMemo(() => skillTargets(homes, worktree, t), [homes, worktree, t]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (skills ?? []).filter((s) => {
      if (homeFilter !== "" && s.home_id !== homeFilter) return false;
      if (scopeFilter !== "" && scopeKey(s) !== scopeFilter) return false;
      return needle === "" || s.name.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle);
    });
  }, [skills, homeFilter, scopeFilter, query]);

  /** Runs a change, shows its failure as text, and reloads the list after it. */
  async function run(action: () => Promise<Toast | null>): Promise<boolean> {
    setBusy(true);
    setError(undefined);
    try {
      setToast(await action());
      return true;
    } catch (e) {
      setError(kitErr(e, true));
      return false;
    } finally {
      setBusy(false);
      reload();
    }
  }

  async function openFolder(skill: Skill): Promise<void> {
    // No command reveals a folder yet, so the path goes to the clipboard.
    try {
      await navigator.clipboard.writeText(displayPath(skill.dir));
      setToast({ text: t("kit.skills.pathCopied", { path: displayPath(skill.dir) }) });
    } catch {
      setToast({ text: t("kit.skills.pathFailed") });
    }
  }

  function startCopy(skill: Skill): void {
    const here = parentOf(skill.dir);
    const first = targets.find((x) => x.dir !== here) ?? targets[0];
    setCopying({ skill, target: first?.dir ?? "" });
  }

  async function remove(skill: Skill): Promise<void> {
    setRemoving(null);
    await run(async () => {
      const aside = await api.kitSkillRemove(skill.dir, worktree);
      return {
        text: t("kit.skills.removed", { name: skill.name }),
        undo: () => {
          setToast(null);
          void run(async () => {
            await api.kitSkillRestore(aside, skill.dir, worktree);
            return { text: t("kit.skills.restored", { name: skill.name }) };
          });
        },
      };
    });
  }

  async function copy(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!copying || copying.target === "") return;
    const { skill, target } = copying;
    if (await run(async () => {
      await api.kitSkillCopy(skill.dir, target, worktree);
      return { text: t("kit.skills.copied", { name: skill.name, dir: target }) };
    })) setCopying(null);
  }

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!adding || adding.target === "") return;
    const { name, description, target } = adding;
    if (await run(async () => {
      const path = await api.kitSkillNew(target, name.trim(), description.trim(), worktree);
      return { text: t("kit.skills.created", { path }) };
    })) setAdding(null);
  }

  const startAdd = () => setAdding({ name: "", description: "", target: targets[0]?.dir ?? "" });
  const targetOptions = (list: SkillTarget[]) =>
    list.map((x) => (
      <option key={x.dir} value={x.dir}>
        {`${x.label} — ${displayPath(x.dir)}`}
      </option>
    ));

  return (
    <div className="kit-skills-tab">
      <div className="kit-bar-row">
        <input
          type="search"
          className="kit-input"
          aria-label={t("kit.skills.search")}
          placeholder={t("kit.skills.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select className="kit-input" aria-label={t("kit.skills.filterHome")} value={homeFilter} onChange={(e) => setHomeFilter(e.target.value)}>
          <option value="">{t("kit.skills.allHomes")}</option>
          {homes.map((h) => (
            <option key={h.id} value={h.id}>{homeLabel(homes, h.id, t)}</option>
          ))}
        </select>
        <select className="kit-input" aria-label={t("kit.skills.filterScope")} value={scopeFilter} onChange={(e) => setScopeFilter(e.target.value)}>
          <option value="">{t("kit.skills.allScopes")}</option>
          {(["user", "project", "plugin"] as const).map((s) => (
            <option key={s} value={s}>{s === "plugin" ? t("kit.scope.plugin", { name: "" }).trim() : t(`kit.scope.${s}`)}</option>
          ))}
        </select>
        <span className="kit-spacer" />
        <Button type="button" disabled={targets.length === 0} title={targets.length === 0 ? t("kit.skills.noTarget") : undefined} onClick={startAdd}>
          {t("kit.skills.new")}
        </Button>
      </div>

      {error && <KitError error={error} />}

      {adding && (
        <form className="kit-panel" onSubmit={(e) => void create(e)}>
          <label className="kit-field">
            <span>{t("kit.skills.newName")}</span>
            <input className="kit-input" required value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} />
          </label>
          <label className="kit-field">
            <span>{t("kit.skills.newDescription")}</span>
            <input className="kit-input" required value={adding.description} onChange={(e) => setAdding({ ...adding, description: e.target.value })} />
          </label>
          <label className="kit-field">
            <span>{t("kit.skills.newTarget")}</span>
            <select className="kit-input" value={adding.target} onChange={(e) => setAdding({ ...adding, target: e.target.value })}>
              {targetOptions(targets)}
            </select>
          </label>
          <div className="kit-bar-row">
            <Button type="submit" disabled={busy}>{t("kit.skills.create")}</Button>
            <button type="button" className="btn-secondary" onClick={() => setAdding(null)}>{t("dialog.cancel")}</button>
          </div>
        </form>
      )}

      {copying && (
        <form className="kit-panel" onSubmit={(e) => void copy(e)}>
          <label className="kit-field">
            <span>{t("kit.skills.copyTitle", { name: copying.skill.name })}</span>
            <select className="kit-input" value={copying.target} onChange={(e) => setCopying({ ...copying, target: e.target.value })}>
              {targetOptions(targets)}
            </select>
          </label>
          <div className="kit-bar-row">
            <Button type="submit" disabled={busy || copying.target === ""}>{t("kit.skills.copyGo")}</Button>
            <button type="button" className="btn-secondary" onClick={() => setCopying(null)}>{t("dialog.cancel")}</button>
          </div>
        </form>
      )}

      {skills === undefined ? (
        !error && <p className="kit-empty">{t("kit.loading")}</p>
      ) : shown.length === 0 ? (
        <p className="kit-empty">{t("kit.skills.empty")}</p>
      ) : (
        <SkillTable skills={shown} homes={homes} onOpen={(s) => void openFolder(s)} onCopy={startCopy} onRemove={setRemoving} />
      )}

      {toast && <ToastLine toast={toast} onClose={() => setToast(null)} />}

      <ConfirmDialog
        open={removing !== null}
        title={t("kit.skills.removeTitle", { name: removing?.name ?? "" })}
        body={t("kit.skills.removeBody")}
        confirmLabel={t("kit.skills.remove")}
        onConfirm={() => removing && void remove(removing)}
        onCancel={() => setRemoving(null)}
      />
    </div>
  );
}
