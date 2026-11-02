// Characters Windows refuses in file names; "/" too, since new docs go in the folder root.
const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f]/g;

/** The file a new doc titled `title` is saved as, or null when nothing usable is left. */
export function docFileName(title: string): string | null {
  const base = title
    .trim()
    .replace(/\.md$/i, "")
    .replace(FORBIDDEN, "-")
    .replace(/\s+/g, " ")
    // Windows drops trailing dots and spaces, so "a." and "a" would be the same file.
    .replace(/[. ]+$/, "")
    .trim();
  return base === "" ? null : `${base}.md`;
}

export function newDocContent(title: string): string {
  const heading = title.trim().replace(/\.md$/i, "");
  return `# ${heading}\n\n`;
}
