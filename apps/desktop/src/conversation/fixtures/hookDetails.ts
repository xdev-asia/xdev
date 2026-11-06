// Hook details as the desktop gets them, for tests: what `question_of` (crates/xdev-agent) makes of the
// stdin fixtures in crates/xdev-agent/fixtures/hooks.
import type { HookDetail } from "@/api";

export const detail = (over: Partial<HookDetail>): HookDetail => ({ toolName: null, message: null, isInterrupt: false, error: null, toolInput: null, ...over });

/** `claude-ask-user-question.json`. */
export const ASK_DETAIL: HookDetail = detail({
  toolName: "AskUserQuestion",
  question: {
    kind: "choice",
    text: "Which database should the cache use?",
    header: "Cache",
    options: [
      { label: "Redis", description: "Fast, needs a running server" },
      { label: "SQLite", description: "A file next to the app" },
      { label: "In memory", description: "Lost on restart" },
    ],
    multi: false,
    count: 1,
  },
});
