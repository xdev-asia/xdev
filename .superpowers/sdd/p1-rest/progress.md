# p1-rest progress

Task 1: complete (f51bb03) gh PRs
Task 2: complete (c74cb95) gh issue create, projects, scope error
Task 3: complete (1334f2e) fetch_pull, sparse helpers
Task 4: complete (39c3efd) existing branch and sparse in create_worktree_linked
Task 5: complete (9ed73d3) Tauri commands, CreateRequest, bindings
Task 6: complete (api.ts, mocks, tests)
Task 7: complete (xdev-ui d23ac63) SearchPicker; pin bumped in the task 8 commit
Task 8: complete createSource.ts, itemKindOf

## Decisions and deviations
- Task 4: the add_staged fallback entry has `head: None` (was the start sha); the head is unknown for a branch that existed before.
- Task 2: `project_list` passes `--closed` so closed projects show; the owner is the part of `repo_name` before `/`.
- Task 5: `cargo test -p xdev-desktop` has one failing test, `ptyd::tests::a_dev_build_has_the_binary_next_to_the_app`, which needs a built ptyd binary and is unrelated to this lane.
- Task 6: the mock marks an existing-branch worktree `madeBy: "cli"` so mock remove keeps the branch (the view has no `madeHere`). Local branches in the mock are `main`, `develop` and the kept ones.

Task 9: complete (api/repoId passed to DetailsDialog; error.* keys for tasks 1-5 added here because i18n.test requires them)
Task 10: complete (note kept as CreateExtra.note -> patch.comment; Create more keeps dialog open via onCreate 6th arg)
Task 11: complete (Branch tab: New = pick base via From field, Existing = local branch select; empty name falls back to branch slug)
Task 12: complete (GitHub tab reuses LinkedWorkSearch, which now passes the issue/PR source; Create is disabled on that tab since a pick starts the worktree; test spies prBranch because the mock workspace has no fetched branch)
Task 13: complete (IssuesPanel keeps its issues tree and adds a Segmented + New issue button; PrsList/ProjectsList/NewIssueForm are new files; ghReasonText shared; a PR row calls onOpenPr when given, else prOpen)
Task 14: complete (i18n keys landed with their tasks, en and vi in step; no separate commit needed)
Matrix note (outside this repo): W2 create dialog source tabs/advanced/sparse/note = done; K1 Issues/PRs/Projects/new issue = done; X-4 linked-work search = done.
Deviations: numberedName refactor in task 8; error.* keys for tasks 1-5 added in task 9 (i18n.test requires them); Branch tab "New" mode picks a base via From; Create is disabled on the GitHub tab (a pick starts the worktree).
Gate: -r typecheck ok; -r test ui 155 + desktop 2156 ok; desktop build ok; cargo fmt ok; clippy exit 0; xdev-git/xdev-workspace tests ok; xdev-desktop 427 pass, 1 fail (ptyd a_dev_build_has_the_binary_next_to_the_app, environment, pre-existing); bindings diff clean.

## Review fixes (lane p1-rest, Sonnet)
- Item 4 ruling: the new/existing branch choice is on the Name tab; the Branch tab keeps the existing-branch list. Tested.
- Item 10: [Unverified] the git version floor for `sparse-checkout set --cone --` in a linked worktree; no git docs were available offline. The doc comment on `sparse_set` states only that it was tested on git 2.56.0.
- Item 11 deviation: the branch cannot be deleted at failure, because `pr_branch` fetches it before the create job runs and Retry reuses it. `pr_branch_discard` deletes only a branch `prBranch` itself fetched (and not one a worktree holds); `PendingCreates` calls it when a failed job is dismissed or cancelled, or when a cancelled job then fails.
- Item 12 accepted as is: Segmented instead of Tabs; Projects list without refresh.
- Task 14 (correction to the note above): a separate commit in xdev-internal sets matrix rows W2, K1, X-4 to "Có" with evidence files (dd70fef, not pushed).
