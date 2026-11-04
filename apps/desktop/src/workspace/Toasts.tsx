import { Icon } from "@xdev-asia/ui";
import { useSyncExternalStore } from "react";
import type { JSX } from "react";
import { useI18n } from "@/i18n";
import { dismissToast, getToasts, subscribeToasts } from "./toastStore";

/** The toast stack, bottom right above the footer. Mount once in the workspace. */
export function Toasts(): JSX.Element | null {
  const { t } = useI18n();
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  if (toasts.length === 0) return null;
  return (
    <div className="ws-toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className="ws-toast" role="status">
          <p className="ws-toast-text">{toast.text}</p>
          {toast.actions.map((a) => (
            <button
              key={a.label}
              type="button"
              className="btn-secondary ws-toast-action"
              onClick={() => {
                a.run();
                dismissToast(toast.id);
              }}
            >
              {a.label}
            </button>
          ))}
          <button type="button" className="ws-icon-btn" aria-label={t("toast.close")} title={t("toast.close")} onClick={() => dismissToast(toast.id)}>
            <Icon name="close" size={12} style={{ strokeWidth: 2 }} />
          </button>
        </div>
      ))}
    </div>
  );
}
