import type { UsageSettings } from "@/api";

/** The cache lifetimes `usage_settings_put` accepts, as in Rust. */
export const CACHE_TTL_SHORT_MS = 300_000;
export const CACHE_TTL_LONG_MS = 3_600_000;

/** `UsageSettings::default()` in Rust: log reading and the cache timer are off. */
export const USAGE_DEFAULTS: UsageSettings = {
  display: "used",
  footer: { claude: true, codex: true },
  scan: { claude: false, codex: false },
  cacheTimer: false,
  cacheTtlMs: CACHE_TTL_SHORT_MS,
};
