/** Whether a tab of this cli can show as a chat: only claude and codex have a transcript reader and resume args. */
export function chatCapable(cli: string | null | undefined): cli is "claude" | "codex" {
  return cli === "claude" || cli === "codex";
}
