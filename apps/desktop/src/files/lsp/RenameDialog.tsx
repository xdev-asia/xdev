import { Dialog, Field } from "@xdev-asia/ui";
import { useState } from "react";
import type { JSX } from "react";
import { useI18n } from "@/i18n";

/** Asks for the new name of a symbol; Enter or Rename confirms a name that is not empty and not the old one. */
export function RenameDialog(props: { name: string; onRename(newName: string): void; onCancel(): void }): JSX.Element {
  const { t } = useI18n();
  const [value, setValue] = useState(props.name);
  const name = value.trim();
  const ok = name !== "" && name !== props.name;
  const submit = () => ok && props.onRename(name);
  return (
    <Dialog
      modal
      title={t("lsp.rename.title")}
      confirmLabel={t("lsp.rename.confirm")}
      cancelLabel={t("lsp.rename.cancel")}
      confirmDisabled={!ok}
      onConfirm={submit}
      onCancel={props.onCancel}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field
          label={t("lsp.rename.field")}
          value={value}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
        />
      </form>
    </Dialog>
  );
}
