// What `quick_command_upsert` accepts: the label in characters (trimmed), a terminal command in
// characters (end trimmed), one agent prompt and all prompts together in UTF-8 bytes. The recent
// list keeps this many ids.
export const QUICK_COMMAND_LIMITS = {
  label: 80,
  command: 4000,
  promptBytes: 256 * 1024,
  promptsTotalBytes: 2 * 1024 * 1024,
  recent: 20,
} as const;
