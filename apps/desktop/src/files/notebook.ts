/** One thing a code cell printed or drew. */
export type NotebookOutput =
  | { kind: "text"; text: string; stream?: "stdout" | "stderr" }
  | { kind: "error"; name: string; text: string }
  | { kind: "image"; url: string; mime: "image/png" | "image/jpeg" };

export interface NotebookCell {
  kind: "markdown" | "code" | "raw";
  source: string;
  /** The execution count of a code cell that ran. */
  count: number | null;
  outputs: NotebookOutput[];
}

export interface Notebook {
  /** The code language the notebook names, lower case; "python" when it names none. */
  language: string;
  cells: NotebookCell[];
}

export type NotebookResult = { ok: true; notebook: Notebook } | { ok: false; reason: "json" | "shape" };

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
/** The text without terminal colour and cursor codes. */
export const stripAnsi = (text: string): string => text.replace(ANSI, "");

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** A notebook text field is a string or a list of lines; either way it is one string. */
function joined(value: unknown): string {
  if (typeof value === "string") return value;
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").join("") : "";
}

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/**
 * What a rich output (`execute_result`, `display_data`) shows: a PNG or JPEG as a data URL, else
 * its plain text, else its HTML as text. HTML is never given back as markup.
 */
function bundleOutput(data: Record<string, unknown>): NotebookOutput | null {
  for (const mime of ["image/png", "image/jpeg"] as const) {
    const raw = joined(data[mime]).replace(/\s+/g, "");
    if (raw && BASE64.test(raw)) return { kind: "image", mime, url: `data:${mime};base64,${raw}` };
  }
  const plain = joined(data["text/plain"]);
  if (plain) return { kind: "text", text: stripAnsi(plain) };
  const html = joined(data["text/html"]);
  return html ? { kind: "text", text: html } : null;
}

function outputOf(raw: unknown): NotebookOutput | null {
  const o = record(raw);
  if (!o) return null;
  switch (o.output_type) {
    case "stream":
      return { kind: "text", text: stripAnsi(joined(o.text)), stream: o.name === "stderr" ? "stderr" : "stdout" };
    case "error": {
      const trace = Array.isArray(o.traceback) ? joined(o.traceback.map((l) => (typeof l === "string" ? `${l}\n` : ""))) : "";
      const name = typeof o.ename === "string" ? o.ename : "";
      const value = typeof o.evalue === "string" ? o.evalue : "";
      const text = stripAnsi(trace).trimEnd() || [name, value].filter(Boolean).join(": ");
      return { kind: "error", name, text };
    }
    case "execute_result":
    case "display_data": {
      const data = record(o.data);
      return data ? bundleOutput(data) : null;
    }
    default:
      return null;
  }
}

/** Reads the text of an `.ipynb` file. Anything that is not notebook JSON with a cell list is a failure. */
export function parseNotebook(text: string): NotebookResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: "json" };
  }
  const root = record(json);
  if (!root || !Array.isArray(root.cells)) return { ok: false, reason: "shape" };
  const meta = record(root.metadata);
  const info = record(meta?.language_info);
  const kernel = record(meta?.kernelspec);
  const named = [info?.name, kernel?.language].find((v): v is string => typeof v === "string" && v.trim() !== "");
  const cells: NotebookCell[] = [];
  for (const raw of root.cells) {
    const c = record(raw);
    if (!c) continue;
    const kind = c.cell_type === "markdown" || c.cell_type === "code" ? c.cell_type : "raw";
    const outputs = kind === "code" && Array.isArray(c.outputs) ? c.outputs.map(outputOf).filter((o): o is NotebookOutput => o !== null) : [];
    cells.push({ kind, source: joined(c.source), count: typeof c.execution_count === "number" ? c.execution_count : null, outputs });
  }
  return { ok: true, notebook: { language: (named ?? "python").trim().toLowerCase(), cells } };
}

/** A fenced block of `code` that the code cannot close early: the fence is longer than any backtick run in it. */
export function fenced(code: string, language: string): string {
  const longest = Math.max(0, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language.replace(/[^\w+#.-]/g, "")}\n${code}\n${fence}`;
}
