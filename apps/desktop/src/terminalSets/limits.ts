// What `terminal_set_upsert` and `startup_preset_upsert` accept (see `terminal_sets.rs`): names and
// commands in characters (trimmed), entries per set, steps per sequence, the longest wait in
// seconds, and how many sets (and presets) are kept.
export const TERMINAL_SET_LIMITS = {
  name: 80,
  command: 4000,
  entries: 32,
  steps: 16,
  waitSeconds: 3600,
  list: 64,
} as const;
