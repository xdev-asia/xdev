// The most words of a prompt that a branch name keeps (`FROM_WORK_WORDS` in names.rs).
const WORDS = 4;
// The longest slug (`SLUG_MAX` in names.rs).
const SLUG_MAX = 48;

/**
 * The branch leaf for work that starts with `prompt`, as `names::from_work` in Rust: the first 4
 * words, lowercase, joined with `-`. A word with a letter outside ASCII is dropped whole; `""` when
 * no word is usable. Only the demo mock uses it; the app asks Rust.
 */
export function fromWork(prompt: string): string {
  const words = prompt
    .split(/\s+/)
    .filter((w) => !/[^\x00-\x7f]/.test(w.replace(/[^\p{L}\p{N}\x00-\x7f]/gu, "")))
    .map((w) => w.toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, ""))
    .filter((w) => w !== "")
    .slice(0, WORDS);
  return words
    .join("-")
    .slice(0, SLUG_MAX)
    .replace(/[-./]+$/, "");
}
