import { expect, mock, test } from 'claude-code/testing'

const MINUTE = 60_000

const usage = (percent: number) => ({
  startedAt: 0,
  context: { window: 200_000, tokens: (200_000 * percent) / 100, percent },
  rateLimits: [],
})

test('compacts once inside the window, above the threshold', async ($, on) => {
  const clock = mock.clock(on)
  let compactions = 0
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('session.usage', () => ({ value: usage(25) }))
  on('session.compact', () => {
    compactions += 1
    return { skip: 'test' }
  })

  await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'plugin', name: 'idle-compact' } })
  await clock.advance(49 * MINUTE)
  expect(compactions).toBe(0)

  await clock.advance(2 * MINUTE)
  expect(compactions).toBe(1)

  await clock.advance(5 * MINUTE)
  expect(compactions).toBe(1)
})

test('leaves a session under the threshold alone', async ($, on) => {
  const clock = mock.clock(on)
  let compactions = 0
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('session.usage', () => ({ value: usage(10) }))
  on('session.compact', () => {
    compactions += 1
    return { skip: 'test' }
  })

  await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'plugin', name: 'idle-compact' } })
  await clock.advance(55 * MINUTE)
  expect(compactions).toBe(0)
})

test('does not compact when the window has closed by the time the read answers', async ($, on) => {
  const clock = mock.clock(on)
  let compactions = 0
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('session.usage', async () => {
    await clock.sleep(12 * MINUTE)
    return { value: usage(25) }
  })
  on('session.compact', () => {
    compactions += 1
    return { skip: 'test' }
  })

  await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'plugin', name: 'idle-compact' } })
  await clock.advance(70 * MINUTE)
  expect(compactions).toBe(0)
})
