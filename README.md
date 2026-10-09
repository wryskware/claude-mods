# claude-mods

Claude Code mods by Wrysk, in one marketplace.

| Mod | What it does |
| --- | --- |
| [`idle-compact`](mods/idle-compact) | Compacts a session that is at least 20% full once it has sat idle for 50 to 60 minutes, while the prompt cache is still warm. |
| [`codex-lane`](mods/codex-lane) | Runs worker jobs on Codex in the background, with completion notifications and a `/codex` pane. Needs the `codex` CLI. |

## Install

In any terminal session, at the prompt:

```
/plugin install idle-compact --marketplace wryskware/claude-mods
/plugin install codex-lane --marketplace wryskware/claude-mods
```

Answer `y` to add the marketplace, then choose the user scope so every session gets the mod.
Its hooks run in that session from then on, with no reload.

Or from a shell:

```
claude plugin marketplace add wryskware/claude-mods
claude plugin install idle-compact@claude-mods --scope user
claude plugin install codex-lane@claude-mods --scope user
```

## Update

To pick up a new version, run `claude plugin marketplace update claude-mods` and
`claude plugin update <mod>@claude-mods`, then `/reload-plugins` in the session.

## Develop

To work on a mod from a clone, add the clone as the marketplace instead of the GitHub one:
`claude plugin marketplace add <path to the clone>`. Edits then reach a session on `/reload-plugins`,
with no new version.

```
claude plugin validate mods/idle-compact
claude plugin test mods/idle-compact
claude plugin validate mods/codex-lane
```

Each mod is one folder under `mods/`: `.claude-plugin/plugin.json`, `hooks/hooks.json` naming the
hooks module, and the `*.test.ts` files beside it. The mod's `.claude-plugin/types/` is written by
the engine and is not tracked.

## Sharing

Anyone can install these from `wryskware/claude-mods` with the lines above. No clone is needed.
