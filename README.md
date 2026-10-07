# codex-lane

A Claude Code mod that runs worker jobs on [Codex](https://github.com/openai/codex) in the
background, the way a background Agent subagent runs on Claude.

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
/plugin install codex-lane --marketplace <owner>/codex-lane
```

Or from a local checkout, for one session: `claude --plugin-dir <clone>`.

It needs the `codex` CLI on `PATH`, logged in, and Linux or macOS (`setsid`, `bash`).

## dispatch

| Field | |
| --- | --- |
| `brief` | The self-contained task. Codex sees none of the conversation. |
| `description` | A 3–5 word label for the pane and the notification. |
| `effort` | Codex reasoning effort: `low`, `medium`, `high`, `xhigh`. |
| `cwd` | Working directory; defaults to the session's. |
| `model` | Codex model; defaults to your `~/.codex/config.toml`. |
| `worktree` | `true` runs it in a separate git worktree (`codex exec --worktree`). |

Which work goes to Codex, and at what effort, is up to you. Put your routing rules in your
`CLAUDE.md`.

## Per-workspace sandbox

Jobs run under Codex's `workspace-write` sandbox. A workspace can change that with
`.claude/codex-lane.json`. The mod uses the nearest one at or above the job's `cwd`:

```json
{ "network": true, "addDirs": ["/home/me/.ssh"] }
```

| Key | Effect |
| --- | --- |
| `sandbox` | Codex sandbox mode (`read-only`, `workspace-write`, `danger-full-access`). |
| `network` | `true` allows network access under `workspace-write`. |
| `addDirs` | Extra writable directories (`--add-dir`). |
