import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Popover, RadioGroup } from "@xdev-asia/ui";
import type { Api, AwakeView, KeepAwake } from "@/api";
import { useI18n } from "@/i18n";

const MODES: readonly KeepAwake[] = ["off", "agent", "on"];

export interface KeepAwakeViewProps {
  view: AwakeView;
  open: boolean;
  onToggle(): void;
  onClose(): void;
  onPick(mode: KeepAwake): void;
}

/** The footer item: the mode as a short word, and a popover to change it. */
export function KeepAwakeView(props: KeepAwakeViewProps): JSX.Element {
  const { t } = useI18n();
  const { view } = props;
  const word = t(`keepAwake.mode.${view.mode}`);
  return (
    <Popover
      open={props.open}
      onClose={props.onClose}
      placement="top-start"
      label={t("keepAwake.title")}
      trigger={(aria) => (
        <button
          type="button"
          className="ws-footer-link ws-awake"
          data-action="keep-awake"
          data-held={view.held ? "true" : "false"}
          title={t("keepAwake.title")}
          {...aria}
          onClick={props.onToggle}
        >
          {view.held && <span className="ws-dot" data-dot="working" aria-hidden="true" />}
          {t("keepAwake.item", { mode: word })}
        </button>
      )}
    >
      {!view.supported && <p className="ws-awake-unsupported">{t("keepAwake.unsupported")}</p>}
      <RadioGroup
        name="keep-awake"
        label={t("keepAwake.title")}
        orientation="vertical"
        value={view.mode}
        onChange={(value) => props.onPick(value as KeepAwake)}
        options={MODES.map((mode) => ({ value: mode, label: t(`keepAwake.mode.${mode}`), hint: t(`keepAwake.hint.${mode}`) }))}
      />
    </Popover>
  );
}

/** The footer item with its state: the view comes from the app and follows its changes. */
export function KeepAwakeItem(props: { api: Pick<Api, "keepAwake" | "keepAwakeSet" | "onKeepAwakeChanged"> }): JSX.Element | null {
  const { api } = props;
  const [view, setView] = useState<AwakeView | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let stale = false;
    api.keepAwake().then((v) => !stale && setView(v), () => {});
    const unlisten = api.onKeepAwakeChanged((v) => !stale && setView(v));
    return () => {
      stale = true;
      void unlisten.then((off) => off(), () => {});
    };
  }, [api]);
  if (!view) return null;
  return (
    <KeepAwakeView
      view={view}
      open={open}
      onToggle={() => setOpen((v) => !v)}
      onClose={() => setOpen(false)}
      onPick={(mode) => {
        api.keepAwakeSet(mode).then((v) => setView(v), () => {});
      }}
    />
  );
}
