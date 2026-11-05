import { Dialog, RadioGroup } from "@xdev-asia/ui";
import { useState } from "react";
import type { JSX } from "react";
import type { Provider } from "@/api";
import { useI18n } from "@/i18n";

/** What a switch changes: the tab in front, or the account new tabs start on. */
export type SwitchScope = "tab" | "default";

/** The agent tab in front, when it runs this provider's CLI. */
export interface SwitchTab {
  /** The tab's pty id. */
  id: string;
  label: string;
  /** The account it runs under; null is the CLI's own home. */
  account: string | null;
  /** Its turn is running: a restart ends it. */
  working: boolean;
}

// Mounted only while open: "Use" on an account, with an agent tab of that provider in front.
export function AccountSwitchDialog(props: {
  provider: Provider;
  /** The account to switch to. */
  to: string;
  tab: SwitchTab;
  onApply(scope: SwitchScope): void;
  onCancel(): void;
}): JSX.Element {
  const { t } = useI18n();
  const [scope, setScope] = useState<SwitchScope>("tab");
  const name = (account: string | null) => account ?? t("accounts.switch.cliDefaultName");
  const provider = t(`accounts.provider.${props.provider}`);

  return (
    <Dialog
      modal
      title={t("accounts.switch.scope.title", { name: props.to })}
      confirmLabel={t("accounts.switch.scope.apply")}
      cancelLabel={t("accounts.switch.scope.cancel")}
      onConfirm={() => props.onApply(scope)}
      onCancel={props.onCancel}
      body="plain"
    >
      <RadioGroup
        name="account-switch-scope"
        orientation="vertical"
        label={t("accounts.switch.scope.label")}
        value={scope}
        onChange={(v) => setScope(v === "default" ? "default" : "tab")}
        options={[
          {
            value: "tab",
            label: t("accounts.switch.scope.tab"),
            hint: t(props.tab.working ? "accounts.switch.scope.tabHintWorking" : "accounts.switch.scope.tabHint", { tab: props.tab.label, from: name(props.tab.account) }),
          },
          { value: "default", label: t("accounts.switch.scope.default"), hint: t("accounts.switch.scope.defaultHint", { provider }) },
        ]}
      />
    </Dialog>
  );
}
