import { useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import { Button, Dialog, Field, Icon, Menu, Popover } from "@xdev-asia/ui";
import type { MenuEntry } from "@xdev-asia/ui";
import { toApiError, type Api } from "@/api";
import { useI18n } from "@/i18n";
import { LicenseUpsellContext } from "@/license/ProGate";
import { useLicense } from "@/license/useLicense";
import { applyPresetTo, applyPresetToAll, arrangeable, toggleCanvas } from "./layoutActions";
import { onLayoutRequest, type LayoutRequest } from "./layoutEvents";
import { LAYOUT_PRESETS, applyUserPreset, presetApplies, savedLayoutOf, type LayoutPreset, type UserPreset } from "./layoutPresets";
import type { Sessions } from "./sessions";

export const LAYOUT_NAME_MAX = 40;
export const LAYOUTS_FEATURE = "pro.layouts";

export type LayoutControlsApi = Pick<Api, "layoutPresetsUser" | "layoutPresetSave" | "layoutPresetDelete" | "licenseState" | "licenseRefresh" | "onLicenseChanged">;

/** Asks for the name of the layout being saved. */
function SaveDialog(props: { onSave(name: string): void; onCancel(): void; error: string | null }): JSX.Element {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const clean = name.trim();
  return (
    <Dialog
      title={t("layout.save")}
      modal
      body="plain"
      confirmLabel={t("layout.save.confirm")}
      confirmDisabled={clean === ""}
      cancelLabel={t("dialog.cancel")}
      onConfirm={() => props.onSave(clean)}
      onCancel={props.onCancel}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (clean !== "") props.onSave(clean);
        }}
      >
        <Field label={t("layout.save.name")} value={name} maxLength={LAYOUT_NAME_MAX} autoFocus onChange={(e) => setName(e.target.value)} error={props.error ?? undefined} hint={t("layout.save.hint", { max: LAYOUT_NAME_MAX })} />
      </form>
    </Dialog>
  );
}

/** Lists the saved layouts, each with its own Delete; a delete is a deliberate click here, not an item of the menu. */
function DeleteDialog(props: { saved: UserPreset[]; onDelete(name: string): void; onClose(): void }): JSX.Element {
  const { t } = useI18n();
  return (
    <Dialog title={t("layout.delete.title")} modal alert body="plain" confirmLabel={t("dialog.close")} cancelLabel={null} onConfirm={props.onClose} onCancel={props.onClose}>
      <p>{t("layout.delete.body")}</p>
      <ul className="settings-list">
        {props.saved.map((p) => (
          <li className="settings-item" key={p.name}>
            <div className="settings-item-text">
              <strong>{p.name}</strong>
            </div>
            <Button type="button" variant="secondary" onClick={() => props.onDelete(p.name)}>
              {t("layout.delete", { name: p.name })}
            </Button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

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
export function LayoutControls(props: { api: LayoutControlsApi; sessions: Sessions | null; worktree: string | null }): JSX.Element | null {
  const { api, sessions, worktree } = props;
  const { t } = useI18n();
  const { allows, state: licenseState } = useLicense(api);
  // While the licence is unread nothing is tagged and a Pro action waits; it is not "free" yet.
  const known = licenseState !== null;
  const upsell = useContext(LicenseUpsellContext);
  const [saved, setSaved] = useState<UserPreset[]>([]);
  const [naming, setNaming] = useState(false);
  const [managing, setManaging] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
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
  const reload = () => void api.layoutPresetsUser().then(setSaved, () => undefined);
  useEffect(reload, [api]);
  const save = (name: string) => {
    const at = worktree ? sessions?.layout(worktree) : null;
    if (!at) {
      setNameError(t("layout.save.err.nolayout"));
      return;
    }
    api.layoutPresetSave(name, savedLayoutOf(at)).then(
      () => {
        setNaming(false);
        setNameError(null);
        setSaid(t("layout.saved", { name }));
        reload();
      },
      (e: unknown) => {
        const code = toApiError(e).code;
        if (code === "license_required") {
          setNaming(false);
          upsell(LAYOUTS_FEATURE);
        } else setNameError(code === "bad_arg" || code === "too_large" ? t(`layout.save.err.${code}`, { max: LAYOUT_NAME_MAX }) : t(`error.${code}`));
      },
    );
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
    ...(saved.length > 0 ? [{ type: "group", label: t("layout.menu.saved") } as MenuEntry] : []),
    ...saved.map((preset): MenuEntry => ({
      label: preset.name,
      disabled: layout === null,
      onSelect: () => {
        setOpen(false);
        if (!worktree || !layout) return;
        sessions.setLayout(worktree, applyUserPreset(layout, preset));
        setSaid(t("layoutPreset.applied", { name: preset.name }));
      },
    })),
    {
      label: !known || allows(LAYOUTS_FEATURE) ? t("layout.save") : `${t("layout.save")} · ${t("pro.tag")}`,
      disabled,
      onSelect: () => {
        setOpen(false);
        if (!known) return;
        if (allows(LAYOUTS_FEATURE)) {
          setNameError(null);
          setNaming(true);
        } else upsell(LAYOUTS_FEATURE);
      },
    },
    ...(saved.length > 0
      ? [
          {
            label: t("layout.manage"),
            onSelect: () => {
              setOpen(false);
              setManaging(true);
            },
          } as MenuEntry,
        ]
      : []),
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
      {managing && (
        <DeleteDialog
          saved={saved}
          onClose={() => setManaging(false)}
          onDelete={(name) => {
            void api.layoutPresetDelete(name).then(
              () => {
                setSaid(t("layout.deleted", { name }));
                reload();
              },
              () => undefined,
            );
            if (saved.length <= 1) setManaging(false);
          }}
        />
      )}
      {naming && <SaveDialog error={nameError} onSave={save} onCancel={() => setNaming(false)} />}
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
