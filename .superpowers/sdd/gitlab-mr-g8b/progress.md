# G8b ledger

## Task 0: complete (contract + glab check, no real glab run, no network)
glab 1.117.0 `--help` only. Confirmed from help: `mr view` has `-F/--output json`; `mr merge` has `--yes`, `--sha`, `--squash`, `--rebase`, `-d/--remove-source-branch` (never used), `--auto-merge` (default true; help says auto-merge is enabled when a pipeline runs) -> we append `--auto-merge=false`; `glab api` lists the `:id` placeholder.
Deviation from plan (ruling 9): in 1.117 `glab mr note` is a command group; its own help lists only subcommands, flags (`-m/--message`) are on `glab mr note create`. argv is `mr note create <iid> --message=<body>`. [Unverified] that `--message=<v>` equals form is accepted (flag exists per `create --help` examples with `-m`); [Unverified] older glab without `create`.
From docs.gitlab.com (REST): MR fields iid/title/description/state(opened|closed|merged|locked)/draft/work_in_progress/source_branch/target_branch/author.username/updated_at/sha/merge_status/detailed_merge_status/has_conflicts/web_url. Jobs: id/name/stage/status/allow_failure/web_url; 13 statuses incl. `waiting_for_callback` (added to Pending; plan lacked it). Notes: id/body/author.username/created_at/system; sort/order_by params. Project: squash_option, merge_method.
Still [Unverified]: that `glab mr view --output json` carries `head_pipeline`, `sha`, `detailed_merge_status`, `has_conflicts` (docs show the REST shape only; MR docs example has no head_pipeline); `squash_option` values never/always/default_on/default_off (only default_on/default_off seen verbatim); detailed_merge_status value list (paraphrased); notes list `per_page` (pagination page not read); `type` field of notes (not used); "SHA does not match" stderr text; `glab api` output being plain JSON on stdout.
Fixtures are hand-built from docs examples (ids/names invented).

## Task 1: complete  (gitlab_review.rs pure pieces + 4 fixtures)
## Task 2: complete  (glab calls through Script fake; gitlab.rs: classify/parse_error pub(crate), RawMr left private: not needed since parse_mr is reused)
33 tests pass in `cargo test -p xdev-git --lib gitlab`.
Task 4: complete (api.ts, mockWorkspace mrDetails/mrNotes/mrJobs, mockRemoteSsh entries)
Task 5: complete (PrMergeMenu optional source, readError uses source.errorText)
Task 6: complete (MrPanel + tests; en/vi mrPanel.*/mrReview.* strings added here instead of T7)
Task 7: complete (ReviewPanel, 3-line WorkspaceShell swap)
Gate: vitest 247 passed (14 files), tsc 0, xdev-git gitlab 33, desktop lib 6, bindings clean, fmt ok, clippy exit 0
