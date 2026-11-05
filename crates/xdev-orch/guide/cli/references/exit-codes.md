# Exit codes

| code | meaning | what to do |
|---|---|---|
| 0 | done | continue |
| 1 | anything else | read the message on stderr |
| 2 | usage | fix the flags; run the verb with `--help` |
| 3 | `app_not_running` | tell the user to open xDev |
| 4 | `timeout` | decide: wait again, or report |
| 5 | target gone (`closed`, `not_found`) | the tab or worktree no longer exists; list again |
| 6 | `app_stopped` | xDev quit while you waited; tell the user |
| 7 | denied or not approved | do not retry; ask the user |

Errors print `error: <code>` or a short message on stderr and nothing on stdout.
