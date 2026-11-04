export type TargetShell = "posix" | "windows";

export const IMAGE_EXTENSIONS: readonly string[] = [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".ico"];

// Control bytes: C0 and DEL.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;
// Characters a shell would treat specially; a path with none of them is pasted as it is.
const SPECIAL: Record<TargetShell, RegExp> = {
  posix: /[ "'`$;&|<>(){}[\]*?!#\\]/,
  windows: /[ "'`$;&|<>(){}[\]*?!#^%]/,
};
const BARE: Record<TargetShell, RegExp> = {
  posix: /^[a-zA-Z0-9_./@:-]+$/,
  windows: /^[a-zA-Z0-9_./@:\\-]+$/,
};

/** An image by the extension of its last path segment, any case. */
export function isImagePath(path: string): boolean {
  const base = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  return dot >= 0 && IMAGE_EXTENSIONS.includes(base.slice(dot).toLowerCase());
}

/** The path as one shell word: bare when safe, else single quotes (posix) or double quotes (windows). */
export function shellQuotePath(path: string, shell: TargetShell): string {
  if (BARE[shell].test(path)) return path;
  return shell === "posix" ? `'${path.replaceAll("'", "'\\''")}'` : `"${path}"`;
}

/** `ESC[200~` + text without ESC and C0 controls except tab + `ESC[201~`. */
export function bracketed(text: string): string {
  // eslint-disable-next-line no-control-regex
  return `\x1b[200~${text.replace(/[\x00-\x08\x0a-\x1f\x7f]/g, "")}\x1b[201~`;
}

/** Image text for a bracketed paste: raw when plain, else escaped (posix) or quoted (windows). */
function imageText(path: string, shell: TargetShell): { text: string; raw: boolean } {
  if (!SPECIAL[shell].test(path)) return { text: path, raw: true };
  if (shell === "windows") return { text: `"${path}"`, raw: false };
  return { text: path.replace(/[^a-zA-Z0-9_./@:\-\u0080-￿]/g, (c) => `\\${c}`), raw: false };
}

/**
 * One write per dropped path, in order. An image goes in as a bracketed paste (an agent CLI reads
 * it as an attachment), anything else as a shell-quoted word. A space follows each, except between
 * two images pasted as they are.
 */
export function dropPayloads(paths: readonly string[], shell: TargetShell): string[] {
  const parts = paths.map((path) => {
    if (isImagePath(path) && !CONTROL.test(path)) {
      const { text, raw } = imageText(path, shell);
      return { data: bracketed(text), rawImage: raw };
    }
    return { data: shellQuotePath(path, shell), rawImage: false };
  });
  return parts.map((part, i) => (part.rawImage && parts[i + 1]?.rawImage ? part.data : `${part.data} `));
}
