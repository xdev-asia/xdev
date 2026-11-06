import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import { Icon, Menu, Popover } from "@xdev-asia/ui";
import type { MenuEntry } from "@xdev-asia/ui";
import { useI18n } from "@/i18n";
import { applyPresetTo, applyPresetToAll, arrangeable, toggleCanvas } from "./layoutActions";
import { onLayoutRequest, type LayoutRequest } from "./layoutEvents";
import { LAYOUT_PRESETS, presetApplies, type LayoutPreset } from "./layoutPresets";
import type { Sessions } from "./sessions";

const ALL_PRESETS = LAYOUT_PRESETS.filter((p) => p !== "fullscreen");

/** Asks before a preset changes other projects. Mounted only while open. */
function ConfirmAll(props: { preset: LayoutPreset; count: number; onConfirm(): void; onCancel(): void }): JSX.Element {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);
  const name = t(`layoutPreset.${props.preset}`);
  return (
    <dialog
      ref={dialog}
      role="dialog"
      aria-modal="true"
      className="dialog ws-dialog"
      aria-labelledby="ws-layout-all-title"
      onCancel={(e) => {
        e.preventDefault();
        props.onCancel();
      }}
    >
      <h2 id="ws-layout-all-title" className="dialog-title">
        {t("layoutPreset.all.title", { name })}
      </h2>
      <p className="dialog-body">{t("layoutPreset.all.body", { count: props.count })}</p>
      <div className="dialog-actions">
        <button type="button" className="btn-secondary" autoFocus onClick={props.onCancel}>
          {t("dialog.cancel")}
        </button>
        <button type="button" className="btn" onClick={props.onConfirm}>
          {t("layoutPreset.all.confirm", { count: props.count })}
        </button>
      </div>
    </dialog>
  );
}

/**
 * The layout button of the header with its menu, and the host of the palette's layout requests: it applies
 * a preset to the current worktree, toggles canvas mode, and asks before a preset changes every project.
 */
export function LayoutControls(props: { sessions: Sessions | null; worktree: string | null }): JSX.Element | null {
  const { sessions, worktree } = props;
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState<LayoutPreset | null>(null);
  const [said, setSaid] = useState("");
  const subscribe = (cb: () => void) => (sessions ? sessions.subscribe(cb) : () => {});
  const read = () => (sessions && worktree ? sessions.layout(worktree) : null);
  const layout = useSyncExternalStore(subscribe, read, read);

  const run = (req: LayoutRequest) => {
    if (!sessions) return;
    if (req.kind === "canvas") {
      const at = worktree ? sessions.layout(worktree) : null;
      if (!at || !worktree) return;
      const next = toggleCanvas(at);
      sessions.setLayout(worktree, next);
      setSaid(t(next.canvas?.on ? "canvas.on" : "canvas.off"));
    } else if (req.all) {
      if (arrangeable(sessions).length > 0) setAsking(req.preset);
    } else if (worktree && applyPresetTo(sessions, worktree, req.preset)) {
      setSaid(t("layoutPreset.applied", { name: t(`layoutPreset.${req.preset}`) }));
    }
  };
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => onLayoutRequest((req) => latest.current(req)), []);

  if (!sessions || !worktree) return null;
  const disabled = layout === null;
  const pick = (req: LayoutRequest) => {
    setOpen(false);
    run(req);
  };
  const items: MenuEntry[] = [
    { type: "group", label: t("layoutPreset.menu.arrange") },
    ...LAYOUT_PRESETS.map((preset): MenuEntry => ({
      label: t(`layoutPreset.${preset}`),
      checked: preset === "fullscreen" ? layout?.expanded != null : layout?.preset === preset && !layout.canvas?.on,
      disabled: layout === null || !presetApplies(layout, preset),
      onSelect: () => pick({ kind: "preset", preset, all: false }),
    })),
    { type: "separator" },
    { label: t("canvas.menu.toggle"), checked: layout?.canvas?.on === true, disabled, onSelect: () => pick({ kind: "canvas" }) },
    { type: "separator" },
    { type: "group", label: t("layoutPreset.menu.all") },
    ...ALL_PRESETS.map((preset): MenuEntry => ({
      label: t("layoutPreset.menu.allItem", { name: t(`layoutPreset.${preset}`) }),
      disabled,
      onSelect: () => pick({ kind: "preset", preset, all: true }),
    })),
  ];
  return (
    <>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        placement="bottom-end"
        label={t("layoutPreset.menu.label")}
        trigger={(triggerProps) => (
          <button
            type="button"
            className="ws-icon-btn ws-header-btn"
            aria-label={t("layoutPreset.menu.label")}
            title={t("layoutPreset.menu.label")}
            {...triggerProps}
            onClick={() => setOpen(!open)}
          >
            <Icon name="grid" size={16} />
          </button>
        )}
      >
        <Menu items={items} label={t("layoutPreset.menu.label")} />
      </Popover>
      <span className="cv-sr" role="status">
        {said}
      </span>
      {asking && (
        <ConfirmAll
          preset={asking}
          count={arrangeable(sessions).length}
          onCancel={() => setAsking(null)}
          onConfirm={() => {
            const n = applyPresetToAll(sessions, asking);
            setAsking(null);
            setSaid(t("layoutPreset.appliedAll", { name: t(`layoutPreset.${asking}`), count: n }));
          }}
        />
      )}
    </>
  );
}
