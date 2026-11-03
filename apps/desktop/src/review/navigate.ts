export type ChangeAt = { file: number; chunk: number };

/**
 * The next (dir 1) or previous (dir -1) change across all files in file order, wrapping at the ends.
 * Files with no changes are skipped. `at` null starts from the first (or last) change.
 */
export function nextChange(files: { path: string; chunks: number }[], at: ChangeAt | null, dir: 1 | -1): ChangeAt | null {
  const flat: ChangeAt[] = [];
  files.forEach((f, file) => {
    for (let chunk = 0; chunk < f.chunks; chunk++) flat.push({ file, chunk });
  });
  if (flat.length === 0) return null;
  if (at === null) return dir === 1 ? flat[0] : flat[flat.length - 1];
  const here = flat.findIndex((c) => c.file === at.file && c.chunk === at.chunk);
  if (here >= 0) return flat[(here + dir + flat.length) % flat.length];
  if (dir === 1) return flat.find((c) => c.file > at.file || (c.file === at.file && c.chunk > at.chunk)) ?? flat[0];
  for (let i = flat.length - 1; i >= 0; i--) {
    const c = flat[i];
    if (c.file < at.file || (c.file === at.file && c.chunk < at.chunk)) return c;
  }
  return flat[flat.length - 1];
}
