export type TargetShell = "posix" | "windows";

export const IMAGE_EXTENSIONS: readonly string[] = [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".ico"];

export function isImagePath(_path: string): boolean {
  throw new Error("not implemented");
}

export function shellQuotePath(_path: string, _shell: TargetShell): string {
  throw new Error("not implemented");
}

/** `ESC[200~` + text without ESC and C0 controls except tab + `ESC[201~`. */
export function bracketed(_text: string): string {
  throw new Error("not implemented");
}

/** One write per path. */
export function dropPayloads(_paths: readonly string[], _shell: TargetShell): string[] {
  throw new Error("not implemented");
}
