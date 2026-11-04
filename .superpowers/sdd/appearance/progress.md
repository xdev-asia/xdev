# appearance ledger

Task 1: complete (UiSettings uiFont/editorTheme*/sidebar/statusBar; lenient enums; clamped font clean; bindings regenerated).
Task 2: complete (terminal_themes.rs parse; default selection = 25% foreground over background).
Task 3: complete (store + 4 commands live in terminal_themes.rs, not commands.rs: deviation, mirrors accounts.rs; types exported).
Task 4: complete (api.ts contract, mockSettings, mockThemes + fixtures json + test; pickFile mock returns first fixture path; error.theme_* i18n).

Task 5: complete (xdev-ui commit on feat/appearance: side-tint token, --x-font-body-fallback, src/theme/font.ts). Generated CSS names: --side-tint, --font-body-fallback.
Task 6: complete (xdev-ui FontField; 46 components; test:dist ok). Pin bump goes in the first app commit that uses it (Task 7).
Task 7: complete (ui/theme.ts applyAppearance + font cache; ui/editorTheme.ts store + useEditorTheme). Deviation: editor theme is a module store fed by applyAppearance, because editors have no api handle.
Task 8: complete

Task 9: complete (3d95a1f; editor `data-theme`, `[data-sidebar="tinted"]` CSS, footer `items` from `ui/statusBarItems.ts`).
Task 10: complete (40da6d6; imported schemes resolve in the terminal via `terminal/customSchemes.ts`).
Task 11: complete (947bc6e; `ImportSchemeDialog` with Replace / Keep both / Cancel, Imported optgroup and Remove in `TerminalLookSection`).
Task 12: complete (8dad94e; `settings/usageCredentials.ts`, Credentials group on `UsagePage`, one read on open and one per Check again, no polling, no token ever shown).
Task 13: complete (xdev-internal c4d86e3, not pushed; S3, CFG-P1-6 and M3 set to Có in the gap matrix).

Review fixes:
- mockSettings.ts regex now uses `\u` escapes (git no longer treats the file as binary from the next change on; the fix commit itself still diffs as Bin because the old blob had a NUL).
- Catalog: added `appearance.terminalLink`, `appearance.usageLink`, `terminal.themeImport`, `usage.credentials` with en + vi strings and tests. Id choice: kept the existing ids `appearance.font` and a single `appearance.editorTheme` (it covers the light and dark selects), rather than renaming them.
- Rust: Replace writes the new file over the old one (temp + rename); `import` no longer takes a trash parameter. `theme_name_taken` detail is the stored scheme's display name. A missing file is `not_found`. `mockThemes.ts` mirrors all three.
- xdev-ui: fefe30b FontField merges `style`; 28addfc `disabled` on Segmented and ThemeSwitch (+ CSS). Pin bumped in bd7effd. AppearancePage disables ThemeSwitch and Segmented while a save is busy.

Deviations:
- Replace no longer sends the old file to the OS trash: the brief says to trash the old one only if the paths differ, and a replaced scheme has the same path, so the previous content is overwritten, not recoverable from the trash.
- xdev-ui also gained a `disabled` prop on Segmented and ThemeSwitch (neither had one), and FontField's reset button follows `disabled` (not separately tested).
- Appearance link rows only render when the host passes `openSection`.

Gate (2026-11-04, worktree head before this note 942b8ad):
- `corepack pnpm -r typecheck`: pass (desktop and xdev-ui).
- `corepack pnpm -r test`: desktop 239 files / 2181 tests pass; xdev-ui 52 files / 164 tests pass.
- `corepack pnpm --filter desktop build`: built.
- `cargo fmt --all --check`: pass. `cargo clippy --workspace --all-targets -- -D warnings`: pass.
- `cargo test -p xdev-desktop`: 446 passed, 1 failed (`ptyd::tests::a_dev_build_has_the_binary_next_to_the_app`, needs the built sidecar); after `cargo build --workspace --bins` that test passes. Other crates were not run (`cargo test --workspace` was too slow); no other crate was touched.
- `cargo test -p xdev-desktop export_bindings` + `git diff --exit-code packages/bindings`: no diff.
- `git status` clean in the worktree and in `packages/xdev-ui`.
