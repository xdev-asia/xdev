import { Button, Popover, SearchPicker, type SearchPickerItem } from "@xdev-asia/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX, MouseEvent } from "react";
import type { Api, ProfilesView } from "@/api";
import { useI18n } from "@/i18n";
import { ContextMenu, type MenuItem } from "@/ui/ContextMenu";
import { BLANK, matchAgents, type AgentEntry } from "./agentPick";

/** The program a profile runs, by name: the file it was found as, else what it is set to start. */
function commandOf(p: ProfilesView["profiles"][number]): string {
  const found = p.path?.split(/[\\/]/).pop()?.replace(/\.(exe|cmd|bat|ps1)$/i, "");
  return found || p.profile.program || p.profile.cli || p.profile.id;
}

/** The agents the picker offers: on and installed, in the profile order. */
export function pickerEntries(view: ProfilesView): AgentEntry[] {
  return view.profiles
    .filter((p) => p.profile.enabled && p.installed)
    .map((p) => ({ id: p.profile.id, label: p.profile.name, command: commandOf(p) }));
}

/** The row menu of `id`: make it the default agent, or a disabled mark when it already is. */
export function agentMenuItems(api: Api, view: ProfilesView, id: string, onView: (next: ProfilesView) => void): MenuItem[] {
  if (view.defaultAgent === id) return [{ id: "default", labelKey: "workspace.agentPicker.isDefault", disabled: true }];
  return [
    {
      id: "default",
      labelKey: "workspace.agentPicker.setDefault",
      run: () => void api.profilesDefaults(view.approvals, id, view.defaultShell).then(onView, () => {}),
    },
  ];
}

/**
 * The agent picker of the `+` menu and `agent.new`: a search over the installed agents with the
 * blank terminal first. A pick gives the profile id, or null for the default shell.
 */
export function AgentPicker(props: {
  api: Api;
  view: ProfilesView;
  /** The query it opens with; empty by default. */
  initialQuery?: string;
  onPick(id: string | null): void;
  onClose(): void;
  /** Opens Settings → Agents. */
  onManage(): void;
  /** The profile view after a default was set. */
  onView(next: ProfilesView): void;
}): JSX.Element {
  const { api, view } = props;
  const { t } = useI18n();
  const [query, setQuery] = useState(props.initialQuery ?? "");
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  // The popover focuses its panel first; the search box takes the focus right after.
  useEffect(() => {
    const id = setTimeout(() => box.current?.querySelector("input")?.focus(), 0);
    return () => clearTimeout(id);
  }, []);

  const blankLabel = t("workspace.agentPicker.blank");
  const onMenu = (id: string) => (e: MouseEvent) => {
    e.preventDefault();
    setMenu({ id, x: e.clientX, y: e.clientY });
  };
  const items: SearchPickerItem[] = matchAgents(query, pickerEntries(view), blankLabel).map((entry) => ({
    id: entry.id,
    title: (
      <span onContextMenu={onMenu(entry.id)} data-agent={entry.id}>
        {entry.label}
      </span>
    ),
    meta: entry.id === BLANK ? undefined : entry.command,
  }));

  return (
    <Popover open onClose={props.onClose} label={t("workspace.agentPicker.label")} placement="bottom-start" className="ws-agent-picker">
      <div ref={box}>
        <SearchPicker
          label={t("workspace.agentPicker.label")}
          placeholder={t("workspace.agentPicker.search")}
          value={query}
          onValueChange={setQuery}
          items={items}
          status={items.length === 0 ? t("workspace.agentPicker.empty") : undefined}
          labels={{ clear: t("search.clear") }}
          onPick={(id) => props.onPick(id === BLANK ? null : id)}
        />
      </div>
      <div className="ws-agent-picker-foot">
        <Button
          variant="secondary"
          type="button"
          onClick={() => {
            props.onClose();
            props.onManage();
          }}
        >
          {t("workspace.agentPicker.manage")}
        </Button>
      </div>
      {menu && (
        <ContextMenu
          at={{ x: menu.x, y: menu.y }}
          items={agentMenuItems(api, view, menu.id, props.onView)}
          onClose={() => setMenu(null)}
        />
      )}
    </Popover>
  );
}
