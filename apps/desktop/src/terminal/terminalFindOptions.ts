export type FindOptions = { caseSensitive: boolean; regex: boolean; wholeWord: boolean };

const OFF: FindOptions = { caseSensitive: false, regex: false, wholeWord: false };

// One copy for the window session, shared by every pane's find bar; not saved (R7).
let current: FindOptions = OFF;

export function getFindOptions(): FindOptions {
  return current;
}

export function setFindOptions(next: FindOptions): void {
  current = { ...next };
}

/** Tests only. */
export function resetFindOptionsForTests(): void {
  current = OFF;
}
