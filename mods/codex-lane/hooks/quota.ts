// Quota lane: one line of Claude/Codex/Antigravity usage the model reads beside each prompt
// and after each Agent or dispatch call, so it can pick a lane without asking.
//
// The numbers come from `ai-usagebar usage --json`, which owns the credentials
// and the provider rate limits. It is asked at most every 5 minutes, from the
// mod's timer (register.tsx runs it), never from a hook a prompt waits on; without it the line is
// simply left out. Spawns counted since the last sample cover a burst of
// dispatches the sample cannot see yet.

const WEEK = 604800
const FIVE_HOUR = 18000
const MAX_AGE_MS = 300_000
const RETRY_MS = 60_000

type Metric = { label: string; percent?: number; window_secs?: number; reset_at?: string }
type Entry = { id: string; metrics?: Metric[]; error?: string | null }
type Window = { name: string; pct: number; resetsAt?: number; windowSecs?: number }
type Lane = { windows: Window[]; error?: string }

export type LaneName = 'claude' | 'codex' | 'agy'

const VENDORS: Record<string, LaneName> = { anthropic: 'claude', openai: 'codex', antigravity: 'agy' }
/** Antigravity also meters its Claude & GPT-OSS models; jobs here use only Gemini. */
const KEEP: Partial<Record<LaneName, RegExp>> = { agy: /^Gemini/ }

let sample: { at: number; lanes: Partial<Record<LaneName, Lane>> } | undefined
let lastTry = 0
let refreshing = false
const spawned: Record<LaneName, number> = { claude: 0, codex: 0, agy: 0 }

/** Counts a spawn on a lane until the next sample shows its usage. */
export function countSpawn(lane: LaneName) {
  spawned[lane]++
}

/** Claims a refresh when the sample is stale and none is running; pair with endQuotaRefresh. */
export function startQuotaRefresh(): boolean {
  const now = Date.now()
  if (refreshing || now - lastTry < RETRY_MS) return false
  if (sample && now - sample.at < MAX_AGE_MS) return false
  refreshing = true
  lastTry = now
  return true
}

export function endQuotaRefresh() {
  refreshing = false
}

/** Takes `ai-usagebar usage --json` output as the new sample; bad JSON keeps the old one. */
export function applyQuotaReport(stdout: string) {
  let report: { entries?: Entry[] }
  try {
    report = JSON.parse(stdout) as { entries?: Entry[] }
  } catch {
    return
  }
  const lanes: Partial<Record<LaneName, Lane>> = {}
  for (const entry of report.entries ?? []) {
    const lane = VENDORS[entry.id]
    if (!lane) continue
    lanes[lane] = {
      error: entry.error ?? undefined,
      windows: (entry.metrics ?? [])
        .filter(m => typeof m.percent === 'number' && (KEEP[lane]?.test(m.label) ?? true))
        .map(m => ({
          name: m.label.replace(/\s*\([^)]*\)\s*$/, '').trim(),
          pct: m.percent as number,
          resetsAt: m.reset_at ? Date.parse(m.reset_at) : undefined,
          windowSecs: m.window_secs,
        })),
    }
  }
  sample = { at: Date.now(), lanes }
  spawned.claude = 0
  spawned.codex = 0
  spawned.agy = 0
}

function span(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d${h % 24}h`
}

/** Points above (+) or below (−) an even burn of a weekly window. */
function pace(w: Window, now: number): number | undefined {
  if (w.windowSecs !== WEEK || w.resetsAt === undefined) return undefined
  const remaining = w.resetsAt - now
  if (remaining <= 0 || remaining > WEEK * 1000) return undefined
  return Math.round(w.pct - 100 * (1 - remaining / (WEEK * 1000)))
}

function describe(lane: Lane | undefined, now: number): string {
  if (!lane) return 'no data'
  if (lane.windows.length === 0) return lane.error ? 'unavailable' : 'no data'
  return lane.windows
    .map(w => {
      if (w.windowSecs === FIVE_HOUR) return `5h ${w.pct}%`
      const p = pace(w, now)
      const label = /weekly$/i.test(w.name) ? 'week' : `${w.name} week`
      const parts = [p === undefined ? undefined : `${p >= 0 ? '+' : '−'}${Math.abs(p)} vs pace`,
        w.resetsAt ? `resets in ${span(w.resetsAt - now)}` : undefined].filter(Boolean)
      return `${label} ${w.pct}%${parts.length ? ` (${parts.join(', ')})` : ''}`
    })
    .join(', ')
}

/** The line the model reads, or undefined while there is no sample. */
export function quotaLine(): string | undefined {
  if (!sample) return undefined
  const now = Date.now()
  const counts = spawned.claude || spawned.codex || spawned.agy
    ? ` | spawned since: claude ${spawned.claude}, codex ${spawned.codex}, agy ${spawned.agy}`
    : ''
  // Left out for anyone without Antigravity in ai-usagebar.
  const agy = sample.lanes.agy ? ` | agy: ${describe(sample.lanes.agy, now)}` : ''
  return `[quota, ${span(now - sample.at)} old] claude: ${describe(sample.lanes.claude, now)} | codex: ${describe(sample.lanes.codex, now)}${agy}${counts}`
}
