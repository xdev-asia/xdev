import type { Accounts, Quota } from "@/api";

export type UsageMode = "detailed" | "compact";
/** localStorage key of the popover mode. */
export const USAGE_MODE_KEY = "xdev.usage.mode";

export type UsageRow = {
  account: string;
  provider: string | null;
  state: Quota["state"];
  /** The login expired, was signed out, or never existed: the person has to sign in again. */
  signIn: boolean;
  /** `percent` is whole percent used (may pass 100), `resetsAt` is epoch milliseconds. */
  windows: { key: string; label: string; percent: number | null; resetsAt: number | null }[];
};

export type { Accounts };
