import { expect, it } from "vitest";
import { checkoutChoices } from "./CheckoutBranchDialog";

const LIST = [
  { name: "main", remote: false },
  { name: "me/oak", remote: false },
  { name: "origin/main", remote: true },
  { name: "origin/feat/x", remote: true },
  { name: "origin/HEAD", remote: true },
];

it("leaves out the current branch, remote copies of local branches and the remote HEAD", () => {
  expect(checkoutChoices(LIST, "me/oak", "").map((b) => b.name)).toEqual(["main", "origin/feat/x"]);
});

it("filters by what was typed, ignoring case", () => {
  expect(checkoutChoices(LIST, null, " FEAT ").map((b) => b.name)).toEqual(["origin/feat/x"]);
  expect(checkoutChoices(LIST, null, "zzz")).toEqual([]);
});
