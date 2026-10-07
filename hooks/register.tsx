// codex-lane: run worker jobs on Codex in the background.
//
// The model calls `dispatch` with a self-contained brief, as it would spawn a
// background Agent. The job runs detached (`setsid`), outside this module, so a
// reload or a restart never kills it; everything it writes lands in
// ~/.cache/codex-lane/<id>/. A 5s timer watches for the DONE marker and, when it
// appears, submits the final report as a prompt, which wakes an idle session the
// way a finished background agent's notification does. The disk is the source of
// truth: after a reload the timer picks the jobs up again from there.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, JobView } from '../types'

const PLUGIN = 'codex-lane'
const PANE = 'codex-lane'
const TICK_MS = 5000
const REPORT_LIMIT = 20000

const jobsAtom = atom({ plugin: 'codex-lane', key: 'jobs' } as const, [] as JobView[])
const agentsAtom = atom({ plugin: 'codex-lane', key: 'agents' } as const, [] as AgentRow[])
const nowAtom = atom({ plugin: 'codex-lane', key: 'now' } as const, 0)

/** Codex reasoning efforts, passed through as `model_reasoning_effort`. */
const EFFORTS = ['low', 'medium', 'high', 'xhigh']

// One job, detached. Its stdio is closed first so `$.process.run` returns at
// once; `setsid` makes it a process group of its own, so cancel kills the tree.
const RUNNER = `exec </dev/null >/dev/null 2>&1
dir=$1; shift
echo $$ > "$dir/pid"
codex exec "$@" - < "$dir/brief.md" > "$dir/events.jsonl" 2> "$dir/stderr.log"
code=$?
[ -e "$dir/exit" ] || echo "$code" > "$dir/exit"
touch "$dir/DONE"`

type Meta = {
  id: string
  session: string
  description: string
  effort: string
  model?: string
  cwd: string
  startedAt: number
  args: string[]
}

/** Optional per-workspace sandbox exceptions, read from <dir>/.claude/codex-lane.json. */
type WorkspaceConfig = { sandbox?: string; network?: boolean; addDirs?: string[] }

let root: string | undefined
let ticking = false
/** Finished jobs never change again; keep them out of the per-tick reads. */
const finished = new Map<string, JobView>()

async function jobsRoot($: EngineInterface): Promise<string> {
  if (!root) {
    const home = (await $.process.run(['printenv', 'HOME'])).stdout.trim()
    root = `${home}/.cache/codex-lane`
  }
  return root
}

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  return $.fs.read(path).catch(() => undefined)
}

async function workspaceConfig($: EngineInterface, cwd: string): Promise<WorkspaceConfig> {
  for (let dir = cwd.replace(/\/+$/, ''); ; dir = dir.slice(0, dir.lastIndexOf('/'))) {
    const text = await readText($, `${dir}/.claude/codex-lane.json`)
    if (text !== undefined) return JSON.parse(text) as WorkspaceConfig
    if (!dir) return {}
  }
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

function statusOf(exit: string): JobView['status'] {
  if (exit === 'cancelled') return 'cancelled'
  return exit === '0' ? 'done' : 'failed'
}

async function notify($: EngineInterface, meta: Meta, dir: string, view: JobView) {
  const report = (await readText($, `${dir}/last.md`))?.trim() ?? ''
  const parts = [
    `[codex-lane] Codex job ${meta.id} (${meta.description}) ${view.status} after ${duration(
      (view.endedAt ?? meta.startedAt) - meta.startedAt,
    )}.`,
  ]
  if (report) {
    parts.push(report.length > REPORT_LIMIT
      ? `${report.slice(0, REPORT_LIMIT)}\n\n…(report cut; call result("${meta.id}") for the rest)`
      : report)
  } else {
    const stderr = (await readText($, `${dir}/stderr.log`))?.trim() ?? ''
    parts.push(`No final report. stderr tail:\n${stderr.slice(-4000) || '(empty)'}`)
  }
  parts.push(`Logs: ${dir}/ (events.jsonl, stderr.log, last.md)`)
  void $.prompt.submit({ text: parts.join('\n\n') })
}

async function tick($: EngineInterface) {
  if (ticking) return
  ticking = true
  try {
    const base = await jobsRoot($)
    const session = await $.session.id()
    const now = Date.now()
    const views: JobView[] = []

    for (const entry of await $.fs.list(base).catch(() => [])) {
      if (entry.kind !== 'dir') continue
      const known = finished.get(entry.name)
      if (known) {
        views.push(known)
        continue
      }
      const dir = `${base}/${entry.name}`
      const metaText = await readText($, `${dir}/meta.json`)
      if (!metaText) continue
      const meta = JSON.parse(metaText) as Meta
      if (meta.session !== session) continue

      let isDone = await $.fs.exists(`${dir}/DONE`)
      if (!isDone) {
        // A runner that died without its marker (a reboot, a kill -9) is lost.
        const pid = (await readText($, `${dir}/pid`))?.trim()
        const alive = pid ? (await $.process.run(['kill', '-0', pid])).exitCode === 0 : true
        if (!alive && !(await $.fs.exists(`${dir}/DONE`))) {
          await $.fs.write(`${dir}/exit`, 'lost\n')
          await $.fs.write(`${dir}/DONE`, '')
        }
        isDone = await $.fs.exists(`${dir}/DONE`)
      }

      const view: JobView = {
        id: meta.id,
        description: meta.description,
        effort: meta.effort,
        cwd: meta.cwd,
        startedAt: meta.startedAt,
        status: 'running',
      }
      if (isDone) {
        view.status = statusOf(((await readText($, `${dir}/exit`)) ?? '').trim())
        view.endedAt = (await $.fs.stat(`${dir}/DONE`)).mtimeMs
        finished.set(meta.id, view)
        if (!(await $.fs.exists(`${dir}/notified`))) {
          await $.fs.write(`${dir}/notified`, '')
          await notify($, meta, dir, view)
        }
      }
      views.push(view)
    }

    views.sort((a, b) => a.startedAt - b.startedAt)
    const running = views.filter(v => v.status === 'running').length
    $.ui.status(running ? `codex ▸ ${running} running` : undefined)

    const agents = (await $.agent.list()).map(a => ({
      id: a.id,
      description: a.description,
      type: a.type,
      status: a.status,
    }))
    await update($, jobsAtom, () => views)
    await update($, agentsAtom, () => agents)
    await update($, nowAtom, () => now)
  } finally {
    ticking = false
  }
}

const DISPATCH_DESCRIPTION = `Start a worker job on Codex (OpenAI; the model in ~/.codex/config.toml unless \`model\` is given) in the background: the Codex equivalent of spawning a background Agent worker.

Returns a job id at once. When the job finishes, its final report arrives as a new message, as a finished background agent's does: do not poll, sleep or wait for it.

\`brief\` must be self-contained, exactly as for an Agent worker: objective, deliverable, relevant files, constraints, decision authority, verification method, return format. Codex sees none of this conversation.

\`effort\` is Codex's reasoning effort (low, medium, high, xhigh). It runs in \`cwd\` (default: the session's) under the workspace-write sandbox, unless that workspace's .claude/codex-lane.json says otherwise. Set \`worktree: true\` to run it in a separate git worktree instead of the working tree.`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'dispatch',
      description: DISPATCH_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          brief: { type: 'string', description: 'The self-contained task brief.' },
          description: { type: 'string', description: 'A short (3-5 word) label for the job.' },
          effort: { type: 'string', enum: EFFORTS },
          cwd: { type: 'string', description: 'Absolute working directory; default the session cwd.' },
          model: { type: 'string', description: 'Codex model override; omit for the configured default.' },
          worktree: { type: 'boolean', description: 'Run in a separate git worktree.' },
        },
        required: ['brief', 'description', 'effort'],
      },
    })
    await $.tool.register({
      name: 'result',
      description:
        'Read a Codex job\'s status and its full final report. Only needed when the completion message cut the report short, or to check a job on request; never to poll.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    })
    await $.tool.register({
      name: 'cancel',
      description: 'Cancel a running Codex job (kills its whole process tree).',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    })
    await $.command.register({ name: 'codex', description: 'Show Codex jobs and Claude subagents in a pane' })

    $.clock.every(TICK_MS, () => tick($))
    void tick($)
    return next(e)
  })

  on('tool.call', { tool: 'mcp__codex-lane__dispatch' }, async ($, e) => {
    const input = e
    const { effort } = input
    if (!EFFORTS.includes(effort)) return { deny: `Unknown effort "${effort}"; use one of ${EFFORTS.join(', ')}.` }

    const cwd = input.cwd ?? (await $.process.run(['pwd'])).stdout.trim()
    if (!(await $.fs.exists(cwd))) return { deny: `cwd ${cwd} does not exist.` }
    const config = await workspaceConfig($, cwd)

    const base = await jobsRoot($)
    const id = `cx-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const dir = `${base}/${id}`

    const args = [
      '--json',
      '--skip-git-repo-check',
      '-C', cwd,
      '-o', `${dir}/last.md`,
      '-s', config.sandbox ?? 'workspace-write',
      '-c', `model_reasoning_effort="${effort}"`,
    ]
    if (input.model) args.push('-m', input.model)
    if (config.network) args.push('-c', 'sandbox_workspace_write.network_access=true')
    for (const extra of config.addDirs ?? []) args.push('--add-dir', extra)
    if (input.worktree) args.push('--worktree')

    const meta: Meta = {
      id,
      session: await $.session.id(),
      description: input.description,
      effort,
      model: input.model,
      cwd,
      startedAt: Date.now(),
      args,
    }
    await $.fs.write(`${dir}/brief.md`, input.brief)
    await $.fs.write(`${dir}/meta.json`, JSON.stringify(meta, null, 2))

    const started = await $.process.run(['setsid', '-f', 'bash', '-c', RUNNER, PLUGIN, dir, ...args])
    if (started.exitCode !== 0) {
      return { deny: `Could not start Codex: ${started.stderr.trim() || `exit ${started.exitCode}`}` }
    }
    void tick($)

    const sandbox = [config.sandbox ?? 'workspace-write', config.network && 'network on'].filter(Boolean).join(', ')
    return {
      result: `Started Codex job ${id} (effort ${effort}${input.model ? `, ${input.model}` : ''}; ${sandbox}${input.worktree ? ', own worktree' : ''}) in ${cwd}. Its report arrives as a message when it finishes; don't poll. Logs: ${dir}/`,
    }
  })

  on('tool.call', { tool: 'mcp__codex-lane__result' }, async ($, e) => {
    const { id } = e
    const dir = `${await jobsRoot($)}/${id}`
    if (!(await $.fs.exists(`${dir}/meta.json`))) return { deny: `No Codex job ${id}.` }
    if (!(await $.fs.exists(`${dir}/DONE`))) return { result: `Codex job ${id} is still running. Logs: ${dir}/` }
    const exit = ((await readText($, `${dir}/exit`)) ?? '').trim()
    const report = (await readText($, `${dir}/last.md`))?.trim()
    const stderr = report ? '' : `\n\nstderr tail:\n${((await readText($, `${dir}/stderr.log`)) ?? '').slice(-4000)}`
    return { result: `Codex job ${id}: ${statusOf(exit)} (exit ${exit}).\n\n${report || '(no final report)'}${stderr}` }
  })

  on('tool.call', { tool: 'mcp__codex-lane__cancel' }, async ($, e) => {
    const { id } = e
    const dir = `${await jobsRoot($)}/${id}`
    if (!(await $.fs.exists(`${dir}/meta.json`))) return { deny: `No Codex job ${id}.` }
    if (await $.fs.exists(`${dir}/DONE`)) return { result: `Codex job ${id} already finished.` }
    // The cancel is its own notice: mark it notified so no completion prompt follows.
    await $.fs.write(`${dir}/notified`, '')
    await $.fs.write(`${dir}/exit`, 'cancelled\n')
    const pid = (await readText($, `${dir}/pid`))?.trim()
    if (pid) await $.process.run(['kill', '-s', 'TERM', '--', `-${pid}`])
    await $.fs.write(`${dir}/DONE`, '')
    void tick($)
    return { result: `Cancelled Codex job ${id}.` }
  })

  on('command.run', { command: 'codex' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Workers' })
    void tick($)
    return { text: 'Workers pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const jobs = await read($, jobsAtom)
    const agents = await read($, agentsAtom)
    const now = await read($, nowAtom)
    const COLOR: Record<JobView['status'], string> = {
      running: 'warning',
      done: 'success',
      failed: 'error',
      cancelled: 'inactive',
    }

    return (
      <Box flexDirection="column">
        <Text bold>Codex</Text>
        {jobs.length === 0 && <Text dimColor>  No Codex jobs this session.</Text>}
        {jobs.map(job => (
          <Text wrap="truncate-end">
            <Text color={COLOR[job.status]}>{job.status === 'running' ? '▸' : job.status === 'done' ? '✓' : '✗'}</Text>
            {` ${job.description}  `}
            <Text dimColor>
              {`${job.effort} · ${duration((job.endedAt ?? now) - job.startedAt)} · ${job.id}`}
            </Text>
          </Text>
        ))}
        <Text> </Text>
        <Text bold>Claude</Text>
        {agents.length === 0 && <Text dimColor>  No subagents this session.</Text>}
        {agents.map(agent => (
          <Text wrap="truncate-end">
            <Text color={agent.status === 'running' ? 'warning' : agent.status === 'completed' ? 'success' : 'inactive'}>
              {agent.status === 'running' ? '▸' : agent.status === 'completed' ? '✓' : '·'}
            </Text>
            {` ${agent.description}  `}
            <Text dimColor>{`${agent.type} · ${agent.status}`}</Text>
          </Text>
        ))}
      </Box>
    )
  })
}
