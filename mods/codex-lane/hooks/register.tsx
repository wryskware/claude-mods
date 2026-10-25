// codex-lane: run worker jobs on Codex, or on Antigravity (Gemini), in the background.
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

import type { AgentRow, DispatchInput, JobView } from '../types'
import { applyQuotaReport, countSpawn, endQuotaRefresh, quotaLine, startQuotaRefresh } from './quota'

const PLUGIN = 'codex-lane'
const PANE = 'codex-lane'
const TICK_MS = 5000
const REPORT_LIMIT = 20000

const jobsAtom = atom({ plugin: 'codex-lane', key: 'jobs' } as const, [] as JobView[])
const agentsAtom = atom({ plugin: 'codex-lane', key: 'agents' } as const, [] as AgentRow[])
const nowAtom = atom({ plugin: 'codex-lane', key: 'now' } as const, 0)

type Engine = 'codex' | 'antigravity'
const ENGINES: Engine[] = ['codex', 'antigravity']
const ENGINE_NAME: Record<Engine, string> = { codex: 'Codex', antigravity: 'Antigravity' }

/** Reasoning efforts. Codex takes `model_reasoning_effort`; agy models carry the effort in their id. */
const EFFORTS: Record<Engine, string[]> = {
  codex: ['low', 'medium', 'high', 'xhigh'],
  antigravity: ['low', 'medium', 'high'],
}
const AGY_DEFAULT_MODEL = 'gemini-3.8-flash'
/** agy takes the prompt as an argument, and Linux caps one argument at 128 KiB. */
const AGY_BRIEF_LIMIT = 100_000
/** Antigravity's own state, writable inside its sandbox. */
const AGY_STATE_DIRS = ['.gemini', '.cache/antigravity', '.config/Antigravity']

// One job, detached. Its stdio is closed first so `$.process.run` returns at
// once; `setsid` makes it a process group of its own, so cancel kills the tree.
const RUNNER = `exec </dev/null >/dev/null 2>&1
dir=$1; shift
echo $$ > "$dir/pid"
codex exec "$@" - < "$dir/brief.md" > "$dir/events.jsonl" 2> "$dir/stderr.log"
code=$?
[ -e "$dir/exit" ] || echo "$code" > "$dir/exit"
touch "$dir/DONE"`

// The same for Antigravity: "$@" is the whole command (bwrap … agy …), and agy
// takes the brief as -p's argument. Its --output-format json reply lands in
// events.jsonl; the module turns it into last.md when the job ends.
const AGY_RUNNER = `exec </dev/null >/dev/null 2>&1
dir=$1; shift
echo $$ > "$dir/pid"
"$@" -p "$(cat "$dir/brief.md")" > "$dir/events.jsonl" 2> "$dir/stderr.log"
code=$?
[ -e "$dir/exit" ] || echo "$code" > "$dir/exit"
touch "$dir/DONE"`

type Meta = {
  id: string
  /** Absent on jobs from before Antigravity: those are Codex. */
  engine?: Engine
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

function engineOf(meta: Meta): Engine {
  return meta.engine ?? 'codex'
}

/** Writes an Antigravity job's last.md from its JSON reply, once. */
async function writeAgyReport($: EngineInterface, dir: string) {
  if (await $.fs.exists(`${dir}/last.md`)) return
  const text = (await readText($, `${dir}/events.jsonl`))?.trim()
  if (!text) return
  try {
    const out = JSON.parse(text) as { status?: string; response?: string }
    const head = out.status && out.status !== 'SUCCESS' ? `(Antigravity status ${out.status})\n\n` : ''
    await $.fs.write(`${dir}/last.md`, `${head}${out.response ?? ''}`)
  } catch {
    // Not JSON (agy failed before replying): notify falls back to stderr.
  }
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
    `[codex-lane] ${ENGINE_NAME[engineOf(meta)]} job ${meta.id} (${meta.description}) ${view.status} after ${duration(
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

/** Asks ai-usagebar for a new quota sample when the last one is stale. */
async function refreshQuota($: EngineInterface) {
  if (!startQuotaRefresh()) return
  try {
    const ran = await $.process.run(['ai-usagebar', 'usage', '--json'], { timeoutMs: 60_000 })
    if (ran.exitCode === 0) applyQuotaReport(ran.stdout)
  } catch {
    // Not installed or timed out: keep the last sample and try again later.
  } finally {
    endQuotaRefresh()
  }
}

async function tick($: EngineInterface) {
  void refreshQuota($)
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
        engine: engineOf(meta),
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
        if (view.engine === 'antigravity') await writeAgyReport($, dir)
        if (!(await $.fs.exists(`${dir}/notified`))) {
          await $.fs.write(`${dir}/notified`, '')
          await notify($, meta, dir, view)
        }
      }
      views.push(view)
    }

    views.sort((a, b) => a.startedAt - b.startedAt)
    const running = ENGINES.map(engine => {
      const n = views.filter(v => v.engine === engine && v.status === 'running').length
      return n ? `${engine === 'codex' ? 'codex' : 'agy'} ▸ ${n} running` : undefined
    }).filter(Boolean)
    $.ui.status(running.length ? running.join(' · ') : undefined)

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

/**
 * Starts an Antigravity job. agy's own --sandbox does not confine files, so
 * workspace-write is bubblewrap: the filesystem read-only except cwd, its git
 * dir, agy's state and any addDirs, with a private /tmp. agy needs the network
 * to reach Gemini, so `network` has no effect here.
 */
async function dispatchAgy(
  $: EngineInterface,
  input: DispatchInput,
  job: { id: string; dir: string; cwd: string; config: WorkspaceConfig },
) {
  const { id, dir, cwd, config } = job
  const model = `${(input.model ?? AGY_DEFAULT_MODEL).replace(/-(low|medium|high)$/, '')}-${input.effort}`
  const agy = ['agy', '--model', model, '--output-format', 'json', '--dangerously-skip-permissions']

  const sandbox = config.sandbox ?? 'workspace-write'
  if (sandbox === 'read-only') return { deny: 'Antigravity has no read-only mode here; use codex for read-only work.' }
  let command: string[]
  if (sandbox === 'danger-full-access') {
    command = ['env', '-C', cwd, ...agy]
  } else {
    const home = (await $.process.run(['printenv', 'HOME'])).stdout.trim()
    const git = await $.process.run(['git', '-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
    const writable = [
      cwd,
      ...AGY_STATE_DIRS.map(d => `${home}/${d}`),
      ...(git.exitCode === 0 ? [git.stdout.trim()] : []),
      ...(config.addDirs ?? []),
    ]
    command = [
      'bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
      ...writable.flatMap(d => ['--bind-try', d, d]),
      '--die-with-parent', '--chdir', cwd,
      ...agy,
    ]
  }

  const meta: Meta = {
    id,
    engine: 'antigravity',
    session: await $.session.id(),
    description: input.description,
    effort: input.effort,
    model,
    cwd,
    startedAt: Date.now(),
    args: command,
  }
  await $.fs.write(`${dir}/brief.md`, input.brief)
  await $.fs.write(`${dir}/meta.json`, JSON.stringify(meta, null, 2))

  const started = await $.process.run(['setsid', '-f', 'bash', '-c', AGY_RUNNER, PLUGIN, dir, ...command])
  if (started.exitCode !== 0) {
    return { deny: `Could not start Antigravity: ${started.stderr.trim() || `exit ${started.exitCode}`}` }
  }
  void tick($)

  countSpawn('agy')
  const quota = quotaLine()
  return {
    ...(quota ? { context: [quota] } : {}),
    result: `Started Antigravity job ${id} (${model}; ${sandbox === 'danger-full-access' ? sandbox : 'bwrap workspace-write, network on'}) in ${cwd}. Its report arrives as a message when it finishes; don't poll. Logs: ${dir}/`,
  }
}

const DISPATCH_DESCRIPTION = `Start a worker job in the background on Codex (OpenAI; the default) or Antigravity (Google's agy CLI, Gemini models): the equivalent of spawning a background Agent worker.

Returns a job id at once. When the job finishes, its final report arrives as a new message, as a finished background agent's does: do not poll, sleep or wait for it.

\`brief\` must be self-contained, exactly as for an Agent worker: objective, deliverable, relevant files, constraints, decision authority, verification method, return format. Codex sees none of this conversation.

\`engine\`: \`codex\` (default) or \`antigravity\`.
- Codex: \`model\` defaults to ~/.codex/config.toml; \`effort\` is low, medium, high or xhigh. Set \`worktree: true\` to run it in a separate git worktree.
- Antigravity: \`model\` is \`gemini-3.8-flash\` (default) or \`gemini-4-argon\` (any \`agy models\` id works); \`effort\` is low, medium or high and picks the model's effort variant. No \`worktree\`. The brief must be under 100k characters.

It runs in \`cwd\` (default: the session's) under a workspace-write sandbox (for Antigravity: bubblewrap, filesystem read-only except \`cwd\`, its git dir and agy's own state; network on), unless that workspace's .claude/codex-lane.json says otherwise.`

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
          engine: { type: 'string', enum: ENGINES, description: 'codex (default) or antigravity.' },
          effort: { type: 'string', enum: EFFORTS.codex },
          cwd: { type: 'string', description: 'Absolute working directory; default the session cwd.' },
          model: { type: 'string', description: 'Model override; omit for the engine default.' },
          worktree: { type: 'boolean', description: 'Run in a separate git worktree.' },
        },
        required: ['brief', 'description', 'effort'],
      },
    })
    await $.tool.register({
      name: 'result',
      description:
        'Read a Codex or Antigravity job\'s status and its full final report. Only needed when the completion message cut the report short, or to check a job on request; never to poll.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    })
    await $.tool.register({
      name: 'cancel',
      description: 'Cancel a running Codex or Antigravity job (kills its whole process tree).',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    })
    await $.command.register({ name: 'codex', description: 'Show Codex and Antigravity jobs and Claude subagents in a pane' })

    $.clock.every(TICK_MS, () => tick($))
    void tick($)
    return next(e)
  })

  on('tool.call', { tool: 'mcp__codex-lane__dispatch' }, async ($, e) => {
    // The matcher does not narrow `e` to this tool's input; the schema above holds it.
    const input = e as unknown as DispatchInput
    const { effort } = input
    const engine = input.engine ?? 'codex'
    if (!ENGINES.includes(engine)) return { deny: `Unknown engine "${engine}"; use ${ENGINES.join(' or ')}.` }
    if (!EFFORTS[engine].includes(effort)) {
      return { deny: `Unknown ${ENGINE_NAME[engine]} effort "${effort}"; use one of ${EFFORTS[engine].join(', ')}.` }
    }
    if (engine === 'antigravity') {
      if (input.worktree) return { deny: 'Antigravity has no worktree mode; make a worktree and pass it as cwd.' }
      if (input.brief.length > AGY_BRIEF_LIMIT) {
        return { deny: `Antigravity briefs must be under ${AGY_BRIEF_LIMIT} characters; point it at a file instead.` }
      }
    }

    const cwd = input.cwd ?? (await $.process.run(['pwd'])).stdout.trim()
    if (!(await $.fs.exists(cwd))) return { deny: `cwd ${cwd} does not exist.` }
    const config = await workspaceConfig($, cwd)

    const base = await jobsRoot($)
    const id = `${engine === 'codex' ? 'cx' : 'ag'}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const dir = `${base}/${id}`

    if (engine === 'antigravity') return dispatchAgy($, input, { id, dir, cwd, config })

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
      engine,
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
    countSpawn('codex')
    const quota = quotaLine()
    return {
      ...(quota ? { context: [quota] } : {}),
      result: `Started Codex job ${id} (effort ${effort}${input.model ? `, ${input.model}` : ''}; ${sandbox}${input.worktree ? ', own worktree' : ''}) in ${cwd}. Its report arrives as a message when it finishes; don't poll. Logs: ${dir}/`,
    }
  })

  on('tool.call', { tool: 'mcp__codex-lane__result' }, async ($, e) => {
    const { id } = e as unknown as { id: string }
    const dir = `${await jobsRoot($)}/${id}`
    if (!(await $.fs.exists(`${dir}/meta.json`))) return { deny: `No job ${id}.` }
    if (!(await $.fs.exists(`${dir}/DONE`))) return { result: `Job ${id} is still running. Logs: ${dir}/` }
    if (id.startsWith('ag-')) await writeAgyReport($, dir)
    const exit = ((await readText($, `${dir}/exit`)) ?? '').trim()
    const report = (await readText($, `${dir}/last.md`))?.trim()
    const stderr = report ? '' : `\n\nstderr tail:\n${((await readText($, `${dir}/stderr.log`)) ?? '').slice(-4000)}`
    return { result: `Job ${id}: ${statusOf(exit)} (exit ${exit}).\n\n${report || '(no final report)'}${stderr}` }
  })

  on('tool.call', { tool: 'mcp__codex-lane__cancel' }, async ($, e) => {
    const { id } = e as unknown as { id: string }
    const dir = `${await jobsRoot($)}/${id}`
    if (!(await $.fs.exists(`${dir}/meta.json`))) return { deny: `No job ${id}.` }
    if (await $.fs.exists(`${dir}/DONE`)) return { result: `Job ${id} already finished.` }
    // The cancel is its own notice: mark it notified so no completion prompt follows.
    await $.fs.write(`${dir}/notified`, '')
    await $.fs.write(`${dir}/exit`, 'cancelled\n')
    const pid = (await readText($, `${dir}/pid`))?.trim()
    if (pid) await $.process.run(['kill', '-s', 'TERM', '--', `-${pid}`])
    await $.fs.write(`${dir}/DONE`, '')
    void tick($)
    return { result: `Cancelled job ${id}.` }
  })

  // The quota line rides beside each prompt and after each spawn, so the model
  // can choose a lane with no call of its own.
  on('prompt.submit', ($, e, next) => {
    const quota = quotaLine()
    return next(quota ? { ...e, context: [...(e.context ?? []), quota] } : e)
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    countSpawn('claude')
    const quota = quotaLine()
    return quota ? { ...ran, context: [...(ran.context ?? []), quota] } : ran
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
        {ENGINES.map(engine => {
          const mine = jobs.filter(job => (job.engine ?? 'codex') === engine)
          return (
            <Box flexDirection="column">
              <Text bold>{ENGINE_NAME[engine]}</Text>
              {mine.length === 0 && <Text dimColor>{`  No ${ENGINE_NAME[engine]} jobs this session.`}</Text>}
              {mine.map(job => (
                <Text wrap="truncate-end">
                  <Text color={COLOR[job.status]}>{job.status === 'running' ? '▸' : job.status === 'done' ? '✓' : '✗'}</Text>
                  {` ${job.description}  `}
                  <Text dimColor>
                    {`${job.effort} · ${duration((job.endedAt ?? now) - job.startedAt)} · ${job.id}`}
                  </Text>
                </Text>
              ))}
              <Text> </Text>
            </Box>
          )
        })}
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
