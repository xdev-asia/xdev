import { Badge, Button } from "@xdev-asia/ui";
import { createContext, useContext } from "react";
import type { JSX, ReactNode } from "react";
import { useI18n } from "@/i18n";
import { useLicense } from "./useLicense";

/** Opens the Pro upsell for a feature. The upsell surface provides it; the default does nothing. */
export const LicenseUpsellContext = createContext<(feature: string) => void>(() => undefined);

export interface ProGateProps {
  /** The Pro feature id, such as `pro.phone`. */
  feature: string;
  children: ReactNode;
  /** Shown when this device lacks the feature. Default: a Pro badge that opens the upsell. */
  fallback?: ReactNode;
}

/** Renders `children` when the license allows `feature`, else `fallback`. Free features are never gated. */
export function ProGate({ feature, children, fallback }: ProGateProps): JSX.Element {
  const { allows } = useLicense();
  const upsell = useContext(LicenseUpsellContext);
  const { t } = useI18n();
  if (allows(feature)) return <>{children}</>;
  if (fallback !== undefined) return <>{fallback}</>;
  return (
    <Button type="button" variant="secondary" onClick={() => upsell(feature)}>
      <Badge>{t("pro.tag")}</Badge>
    </Button>
  );
}
