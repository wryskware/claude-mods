# claude-mods

Claude Code mods by Wrysk, in one marketplace.

| Mod | What it does |
| --- | --- |
| [`idle-compact`](mods/idle-compact) | Compacts a session that is at least 20% full once it has sat idle for 50 to 60 minutes, while the prompt cache is still warm. |

## Install

In any terminal session, at the prompt:

```
/plugin marketplace add <clone>
/plugin install idle-compact@claude-mods
```

Answer `y` to add the marketplace, then choose the user scope so every session gets the mod.
Its hooks run in that session from then on, with no reload.

Or from a shell:

```
claude plugin marketplace add <clone>
claude plugin install idle-compact@claude-mods --scope user
```

## Update

The marketplace is a folder, so the installed mod reads its files from here. Edit a mod, then run
`/reload-plugins` in the session. No reinstall is needed.

## Develop

```
claude plugin validate mods/idle-compact
claude plugin test mods/idle-compact
```

Each mod is one folder under `mods/`: `.claude-plugin/plugin.json`, `hooks/hooks.json` naming the
hooks module, and the `*.test.ts` files beside it. The mod's `.claude-plugin/types/` is written by
the engine and is not tracked.

## Sharing

Once this repository is on GitHub, others install a mod with
`/plugin install <mod> --marketplace <owner>/claude-mods`.
