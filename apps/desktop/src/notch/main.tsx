import { StrictMode, useEffect, useState } from "react";
import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import { api, type NotchState } from "@/api";
import { I18nProvider, useI18n } from "@/i18n";
import { NotchView } from "./NotchView";
import "@xdev-asia/ui/styles.css";
import "./notch.css";

/** The notch window: the state the backend picked, kept current by `notch://state`. */
function NotchApp(): JSX.Element | null {
  const { t } = useI18n();
  const [state, setState] = useState<NotchState>({ view: { kind: "hidden" }, gap: 0 });
  useEffect(() => {
    let off: (() => void) | null = null;
    let closed = false;
    api
      .onNotchState(setState)
      .then((stop) => {
        if (closed) stop();
        else off = stop;
      })
      .catch(() => {});
    void api.notchState().then(setState, () => {});
    return () => {
      closed = true;
      off?.();
    };
  }, []);
  return <NotchView state={state} t={t} onOpen={(id) => void api.notchOpen(id).catch(() => {})} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <NotchApp />
    </I18nProvider>
  </StrictMode>,
);
