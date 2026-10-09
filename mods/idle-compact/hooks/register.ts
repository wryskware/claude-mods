import type { EngineInterface, Register } from 'claude-code'

// The prompt cache lapses an hour after the last request. A compaction reads
// the whole context once, which is cheap only while that cache is still warm,
// so it runs in the window from the idle mark until the cache lapses.
const IDLE_MS = 50 * 60_000
const CACHE_LAPSES_MS = 60 * 60_000
const THRESHOLD_PERCENT = 20
const TICK_MS = 60_000

// Kept in the module, so a reload starts over. A fresh start counts as
// activity, which errs toward waiting longer, never toward compacting early.
let lastActivity: number | undefined
let compactedFor: number | undefined
let armed = false
let busy = false

const inWindow = (now: number, stamp: number) => {
  const idle = now - stamp
  return idle >= IDLE_MS && idle < CACHE_LAPSES_MS
}

const tick = async ($: EngineInterface) => {
  if (busy || lastActivity === undefined) return
  const stamp = lastActivity
  if (compactedFor === stamp) return
  busy = true
  try {
    if (!inWindow(await $.clock.now(), stamp)) return
    const { context } = await $.session.usage()
    if ((context.percent ?? 0) < THRESHOLD_PERCENT) return
    // The usage read takes time: the window must still hold, and nothing may
    // have run since, or the compaction is left alone.
    if (lastActivity !== stamp || !inWindow(await $.clock.now(), stamp)) return
    const result = await $.session.compact()
    compactedFor = stamp
    $.ui.log(`idle compact: ${result.skip ?? 'compacted'}`, { to: 'debug' })
  } catch {
    // Refused (a turn was running) or a failed read: the next tick tries
    // again, for as long as the window holds.
  } finally {
    busy = false
  }
}

const arm = ($: EngineInterface) => {
  if (armed) return
  armed = true
  $.clock.every(TICK_MS, () => void tick($))
}

const touch = async ($: EngineInterface) => {
  lastActivity = await $.clock.now()
  arm($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    lastActivity ??= await $.clock.now()
    arm($)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await touch($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    await touch($)
    return next(e)
  })
}
