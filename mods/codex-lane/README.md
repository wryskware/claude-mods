# codex-lane

A Claude Code mod that runs worker jobs on [Codex](https://github.com/openai/codex), or on
Antigravity's `agy` CLI (Gemini), in the background, the way a background Agent subagent runs
on Claude.

- **`dispatch`**: the model hands Codex a self-contained brief and gets a job id back at once.
  The job runs detached (`setsid codex exec`), so reloading the mod or restarting Claude Code
  doesn't kill it.
- **Completion**: when the job finishes, its final report arrives as a new message and wakes an
  idle session, like a finished background agent's notification. Nothing polls.
- **`result` / `cancel`**: read a job's full report, or kill its whole process tree.
- **`/codex`**: a pane listing this session's Codex jobs next to its Claude subagents. The status
  line shows `codex ▸ N running`.

Each job's files are in `~/.cache/codex-lane/<id>/`: `brief.md`, `meta.json`, `events.jsonl`
(Codex's `--json` stream), `stderr.log`, `last.md` (the final report) and `exit`.

## Install

```
/plugin install codex-lane --marketplace wryskware/claude-mods
```

For one session from a clone: `claude --plugin-dir <clone>/mods/codex-lane`.

It needs the `codex` CLI on `PATH`, logged in, and Linux or macOS (`setsid`, `bash`). The
Antigravity engine also needs `agy` (logged in) and `bwrap` (Linux).

## dispatch

| Field | |
| --- | --- |
| `brief` | The self-contained task. Codex sees none of the conversation. |
| `description` | A 3–5 word label for the pane and the notification. |
| `engine` | `codex` (default) or `antigravity`. |
| `effort` | Codex: `low`, `medium`, `high`, `xhigh`. Antigravity: `low`, `medium`, `high`. |
| `cwd` | Working directory; defaults to the session's. |
| `model` | Codex: defaults to your `~/.codex/config.toml`. Antigravity: `gemini-3.8-flash` (default) or `gemini-4-argon`; the effort picks the variant (`gemini-4-argon-high`). |
| `worktree` | Codex only: `true` runs it in a separate git worktree (`codex exec --worktree`). |

Antigravity jobs run `agy -p <brief> --output-format json --dangerously-skip-permissions` and
have `ag-` ids. agy's own `--sandbox` doesn't confine file writes, so the mod runs it under
`bwrap`: the filesystem is read-only except `cwd`, its git dir, agy's state (`~/.gemini`,
`~/.cache/antigravity`, `~/.config/Antigravity`) and any `addDirs`, with a private `/tmp`.
The network stays on, since agy needs it to reach Gemini. The brief is passed as an argument,
so it must be under 100k characters.

Which work goes to Codex, and at what effort, is up to you. Put your routing rules in your
`CLAUDE.md`.

## Quota line

If `ai-usagebar` is installed, the mod adds one line of Claude and Codex
(and Antigravity Gemini, when it reports one) usage that the model reads with each prompt and after each `Agent` or `dispatch` call:

```
[quota, 2m old] claude: 5h 5%, week 30% (+3 vs pace, resets in 5d3h) | codex: week 8% (+5 vs pace, resets in 6d18h) | spawned since: claude 1, codex 2
```

"vs pace" is percentage points above or below an even burn of the week. The usage is sampled at
most every 5 minutes, so the line also counts the spawns made since the sample was taken. The
mod reports the numbers and the model chooses the lane, by your rules. Without `ai-usagebar` the
line is left out.

## Per-workspace sandbox

Codex jobs run under Codex's `workspace-write` sandbox, Antigravity jobs under the `bwrap` one
above. A workspace can change that with
`.claude/codex-lane.json`. The mod uses the nearest one at or above the job's `cwd`:

```json
{ "network": true, "addDirs": ["/home/me/.ssh"] }
```

| Key | Effect |
| --- | --- |
| `sandbox` | `read-only` (Codex only), `workspace-write`, `danger-full-access` (Antigravity: no `bwrap`). |
| `network` | `true` allows network access under Codex's `workspace-write`. |
| `addDirs` | Extra writable directories (`--add-dir`). |
