import { describe, expect, it } from "vitest";
import lettered from "./fixtures/lettered-choice.txt?raw";
import listThenYesNo from "./fixtures/list-then-yes-no.txt?raw";
import numbered from "./fixtures/numbered-choice.txt?raw";
import plainAnswer from "./fixtures/plain-answer.txt?raw";
import questionFirst from "./fixtures/question-first.txt?raw";
import summaryList from "./fixtures/summary-list.txt?raw";
import yesNoMark from "./fixtures/yes-no-mark.txt?raw";
import yesNo from "./fixtures/yes-no.txt?raw";
import { ASK_DETAIL, detail } from "./fixtures/hookDetails";
import { describeKeys, hookQuestion, parseQuestionText, transcriptQuestion } from "./questions";



describe("parseQuestionText", () => {
  it("reads a numbered list with the question after it", () => {
    const q = parseQuestionText(numbered)!;
    expect(q.kind).toBe("choice");
    expect(q.text).toBe("Which one should I use?");
    expect(q.choices.map((c) => c.label)).toEqual(["Redis – fast, but it needs a running server", "SQLite – a file next to the app", "In memory – lost on restart"]);
    expect(q.choices.map((c) => c.keys)).toEqual(["1\r", "2\r", "3\r"]);
  });

  it("reads a list after its question, with `1)` marks and code", () => {
    const q = parseQuestionText(questionFirst)!;
    expect(q.text).toBe("Which test runner do you want for the new package?");
    expect(q.choices.map((c) => [c.label, c.keys])).toEqual([
      ["vitest", "1\r"],
      ["node:test", "2\r"],
    ]);
  });

  it("reads lettered options", () => {
    const q = parseQuestionText(lettered)!;
    expect(q.text).toBe("Which do you prefer?");
    expect(q.choices.map((c) => c.keys)).toEqual(["a\r", "b\r"]);
  });

  it("reads a yes/no question on the last line", () => {
    const q = parseQuestionText(yesNo)!;
    expect(q.kind).toBe("yes-no");
    expect(q.text).toBe("Should I also commit these changes?");
    expect(q.choices.map((c) => [c.label, c.keys])).toEqual([
      ["yes", "yes\r"],
      ["no", "no\r"],
    ]);
    const marked = parseQuestionText(yesNoMark)!;
    expect(marked.kind).toBe("yes-no");
    expect(marked.text).toBe("Continue?");
  });

  it("takes a yes/no after a list for what it is", () => {
    const q = parseQuestionText(listThenYesNo)!;
    expect(q.kind).toBe("yes-no");
    expect(q.text).toBe("Should I rename them too?");
  });

  it("finds no question in a summary or a plain answer", () => {
    expect(parseQuestionText(summaryList)).toBeNull();
    expect(parseQuestionText(plainAnswer)).toBeNull();
    expect(parseQuestionText("")).toBeNull();
    // A list that does not start at 1 is not a menu.
    expect(parseQuestionText("Pick one?\n2. a\n3. b")).toBeNull();
    // One option is not a choice.
    expect(parseQuestionText("Pick one?\n1. a")).toBeNull();
  });
});

describe("hookQuestion", () => {
  it("answers a claude choice with the option's digit", () => {
    const q = hookQuestion(ASK_DETAIL, "claude");
    expect(q).toMatchObject({ source: "hook", kind: "choice", text: "Which database should the cache use?", header: "Cache", answerable: true });
    expect(q.choices.map((c) => c.keys)).toEqual(["1", "2", "3"]);
    expect(q.choices[1]!.description).toBe("A file next to the app");
  });

  it("answers a claude permission with 1 or Escape", () => {
    const q = hookQuestion(detail({ toolName: "Bash", toolInput: "rm -rf build", question: { kind: "permission", text: "", header: null, options: [], multi: false, count: 1 } }), "claude");
    expect(q).toMatchObject({ kind: "permission", tool: "Bash", toolInput: "rm -rf build", answerable: true });
    expect(q.choices.map((c) => [c.label, c.keys])).toEqual([
      ["yes", "1"],
      ["no", "\x1b"],
    ]);
  });

  it("names a yes/no choice", () => {
    const q = hookQuestion(detail({ question: { kind: "choice", text: "Keep it?", header: null, options: [{ label: "Yes", description: null }, { label: "No", description: null }], multi: false, count: 1 } }), "claude");
    expect(q.kind).toBe("yes-no");
  });

  it("sends the rest to the terminal", () => {
    const multi = { ...ASK_DETAIL.question!, multi: true };
    expect(hookQuestion(detail({ question: multi }), "claude").answerable).toBe(false);
    expect(hookQuestion(detail({ question: { ...ASK_DETAIL.question!, count: 2 } }), "claude").answerable).toBe(false);
    // The format of another CLI's menu is not known.
    expect(hookQuestion(ASK_DETAIL, "codex").answerable).toBe(false);
    expect(hookQuestion(ASK_DETAIL, null).answerable).toBe(false);
    const form = hookQuestion(detail({ question: { kind: "input", text: "Which project?", header: "tickets", options: [], multi: false, count: 1 } }), "claude");
    expect(form).toMatchObject({ kind: "input", text: "Which project?", answerable: false, choices: [] });
    // A needs-input with no question: the card says the agent waits.
    expect(hookQuestion(null, "claude")).toMatchObject({ kind: "input", answerable: false });
  });
});

describe("transcriptQuestion", () => {
  it("is answerable at the prompt of a known CLI only", () => {
    expect(transcriptQuestion(yesNo, "claude")?.answerable).toBe(true);
    expect(transcriptQuestion(yesNo, "codex")?.answerable).toBe(true);
    expect(transcriptQuestion(yesNo, null)?.answerable).toBe(false);
    expect(transcriptQuestion(summaryList, "claude")).toBeNull();
  });
});

describe("describeKeys", () => {
  it("splits text from the keys pressed after it", () => {
    expect(describeKeys("2")).toEqual({ text: "2", enter: false, escape: false });
    expect(describeKeys("yes\r")).toEqual({ text: "yes", enter: true, escape: false });
    expect(describeKeys("\x1b")).toEqual({ text: "", enter: false, escape: true });
  });
});
