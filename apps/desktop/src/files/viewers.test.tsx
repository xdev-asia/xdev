import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));
import { AltViewPane } from "./AltViewPane";
import { CsvView } from "./CsvView";
import { NotebookView } from "./NotebookView";
import { ROW_CAP } from "./csv";
import { viewMode } from "./viewMode";

beforeEach(() => viewMode.reset());

it("the grid has a header row, row numbers and quoted fields with commas and newlines", () => {
  const out = renderToStaticMarkup(<CsvView rel="a.csv" text={'name,note\r\nAnn,"x, y"\r\nBob,"l1\nl2"\r\n'} />);
  expect(out).toContain('<th scope="col" data-cell="-1:0">name</th>');
  expect(out).toContain("<td data-cell=\"0:1\">x, y</td>");
  expect(out).toContain("l1\nl2");
  expect(out).toContain('<th scope="row" class="grid-num">2</th>');
});

it("a tsv grid splits on tabs", () => {
  expect(renderToStaticMarkup(<CsvView rel="a.tsv" text={"a\tb\n1,5\t2"} />)).toContain("<td data-cell=\"0:0\">1,5</td>");
});

it("rows past the cap are counted, not drawn", () => {
  const text = "h\n" + Array.from({ length: ROW_CAP + 3 }, (_, i) => `r${i}`).join("\n");
  const out = renderToStaticMarkup(<CsvView rel="a.csv" text={text} />);
  expect(out).toContain("3 more rows are not shown");
  expect(out).toContain(`The first ${ROW_CAP} rows`);
  expect(out).not.toContain(`>r${ROW_CAP}<`);
});

it("an empty file says so", () => {
  expect(renderToStaticMarkup(<CsvView rel="a.csv" text="" />)).toContain("no rows");
});

const nb = JSON.stringify({
  metadata: { language_info: { name: "python" } },
  cells: [
    { cell_type: "markdown", source: "# Title" },
    { cell_type: "code", execution_count: 1, source: "print('hi')", outputs: [
      { output_type: "stream", name: "stdout", text: "hi\n" },
      { output_type: "display_data", data: { "text/html": "<script>alert(1)</script>" } },
      { output_type: "display_data", data: { "image/png": "iVBORw0KGgo=" } },
      { output_type: "error", ename: "E", evalue: "v", traceback: ["\u001b[31mE\u001b[0m: v"] },
    ] },
  ],
});

it("a notebook shows markdown and code cells and every output kind; html is escaped text", () => {
  const out = renderToStaticMarkup(<NotebookView api={createMockApi({})} worktree="w" rel="n.ipynb" text={nb} />);
  expect(out).toContain('data-cell="markdown"');
  expect(out).toContain('data-cell="code"');
  expect(out).toContain("[1]");
  expect(out).toContain("hi\n</pre>");
  expect(out).toContain('src="data:image/png;base64,iVBORw0KGgo="');
  expect(out).toContain("E: v");
  expect(out).not.toContain("\u001b");
  expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(out).not.toContain("<script>");
});

it("a notebook that is not JSON shows the error and the way to the text", () => {
  const out = renderToStaticMarkup(<NotebookView api={createMockApi({})} worktree="w" rel="n.ipynb" text="{oops" />);
  expect(out).toContain("could not be read");
  expect(out).toContain("not valid JSON");
  expect(out).toContain("Open as text");
});

it("the switch shows the view, or the editor after Open as text", () => {
  const pane = (asText: boolean) => renderToStaticMarkup(<AltViewPane worktree="w" rel="a.csv" label="Table" asText={asText} view={<i>GRID</i>} editor={<i>EDITOR</i>} />);
  expect(pane(false)).toContain("GRID");
  expect(pane(false)).not.toContain("EDITOR");
  expect(pane(true)).toContain("EDITOR");
  expect(pane(false)).toContain("Open as text");
});
