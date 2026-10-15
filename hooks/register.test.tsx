import { expect, mock, test } from 'claude-code/testing'

const PLUGIN = 'glance-band'
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const

const COUNT = { type: 'Text', text: /background tasks? running/ } as const
const CMDS = { type: 'Text', text: /commands? running/ } as const
const WRITING = { type: 'Text', text: /writing (a|\d+) commands?/ } as const
const QUESTIONS = { type: 'Text', text: /questions? waiting/ } as const

const SHELL = { id: 'b1', type: 'shell', status: 'running', description: 'a long build' }
const LOOP = { id: 'c1', schedule: '*/15 * * * *', recurring: true, prompt: 'a loop' }

// every test that reads questions names its own file, so no test reads a real home folder
const QFILE = 'C:/glance-test/questions_waiting.md'
const WITH_QFILE = { options: { questions_file: QFILE } }
const isQ = (p: unknown) => String(p).replace(/\\/g, '/').toLowerCase() === QFILE.toLowerCase()
// the facts of one system-prompt composition, as a session gives them
const FACTS = { model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as const

test('blue with the count while tasks run, grey at zero, on every surface', async ($, on) => {
  on('classic.Stop', async () => ({}))

  for (const surface of ['terminal', 'desktop'] as const) {
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [SHELL], session_crons: [LOOP] })
    let ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
    let count = await ui.find(COUNT)
    expect(count?.text).toBe('2 background tasks running')
    expect(count?.props.color).toBe('suggestion')
    expect((await ui.find({ type: 'Text', text: 'scheduled' }))?.text).toBe(' (1 task, 1 scheduled)')
    await ui.unmount()

    await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [] })
    ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
    count = await ui.find(COUNT)
    expect(count?.text).toBe('0 background tasks running')
    expect(count?.props.color).toBe('inactive')
    await ui.unmount()
  }
})

test('a finished task is not counted', async ($, on) => {
  on('classic.Stop', async () => ({}))
  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [SHELL, { id: 'b2', type: 'shell', status: 'completed', description: 'done' }],
    session_crons: [],
  })
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
  const count = await ui.find(COUNT)
  expect(count?.text).toBe('1 background task running')
  expect(count?.props.color).toBe('suggestion')
  await ui.unmount()
})

test('lilac when a loop alone runs, blue for one real task or for two loops', async ($, on) => {
  on('classic.Stop', async () => ({}))

  for (const surface of ['terminal', 'desktop'] as const) {
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [LOOP] })
    let ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
    let count = await ui.find(COUNT)
    expect(count?.text).toBe('1 background task running')
    expect(count?.props.color).toBe('#C8A2C8')
    const loop = await ui.find({ type: 'Text', text: 'loop' })
    expect(loop?.text).toBe(' (loop)')
    expect(loop?.props.color).toBe('inactive')
    await ui.unmount()

    await $.classic.Stop({ stop_hook_active: false, background_tasks: [SHELL], session_crons: [] })
    ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
    count = await ui.find(COUNT)
    expect(count?.text).toBe('1 background task running')
    expect(count?.props.color).toBe('suggestion')
    await ui.unmount()

    await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [LOOP, { ...LOOP, id: 'c2' }] })
    ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
    count = await ui.find(COUNT)
    expect(count?.text).toBe('2 background tasks running')
    expect(count?.props.color).toBe('suggestion')
    await ui.unmount()
  }
})

const OUT = 'C:/T/tasks/b9.output'
const LAUNCH_TEXT = `Command running in background with ID: b9. Output is being written to: ${OUT}. You will be notified when it completes.`

test('live: a launch counts at once, a stop from the panel turns the band at the next poll, once', async ($, on) => {
  const clock = mock.clock(on)
  let file = 'waiting\n'
  let mtime = 1
  on('classic.Stop', async () => ({}))
  on('tool.call', async () => ({ result: {}, text: LAUNCH_TEXT }))
  on('fs.stat', async () => ({ value: { kind: 'file', size: file.length, mtimeMs: mtime, isLink: false } }))
  on('fs.read', async () => ({ value: file }))

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [LOOP] })
  await $.tool.call({ tool: 'Bash', command: 'sleep 1200', run_in_background: true })
  let ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
  let count = await ui.find(COUNT)
  expect(count?.text).toBe('2 background tasks running')
  expect(count?.props.color).toBe('suggestion')
  await ui.unmount()

  await clock.advance(2000)
  ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
  expect((await ui.find(COUNT))?.text).toBe('2 background tasks running')
  await ui.unmount()

  file = 'waiting\n[killed]\n'
  mtime = 2
  await clock.advance(2000)
  await clock.advance(2000)
  ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
  count = await ui.find(COUNT)
  expect(count?.text).toBe('1 background task running')
  expect(count?.props.color).toBe('#C8A2C8')
  await ui.unmount()
})

test('live: a TaskStop and the file both seeing one end count it once', async ($, on) => {
  const clock = mock.clock(on)
  on('classic.Stop', async () => ({}))
  on('tool.call', async ($, e) =>
    e.tool === 'TaskStop'
      ? { result: { message: 'Successfully stopped task: b9', task_id: 'b9', task_type: 'local_bash' }, text: 'Successfully stopped task: b9' }
      : { result: {}, text: LAUNCH_TEXT },
  )
  on('fs.stat', async () => ({ value: { kind: 'file', size: 20, mtimeMs: 5, isLink: false } }))
  on('fs.read', async () => ({ value: 'x\n[exited with code 0]\n' }))

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [SHELL], session_crons: [] })
  await $.tool.call({ tool: 'Bash', command: 'sleep 1200', run_in_background: true })
  await $.tool.call({ tool: 'TaskStop', task_id: 'b9' })
  await clock.advance(2000)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
  expect((await ui.find(COUNT))?.text).toBe('1 background task running')
  await ui.unmount()
})

test('live: a shell MOVED to the background mid-run counts at once, and so does a background agent', async ($, on) => {
  on('classic.Stop', async () => ({}))
  on('tool.call', async ($, e) =>
    e.tool === 'Agent'
      ? { result: {}, text: 'Async agent launched.' }
      : {
          result: {},
          text:
            'Command was moved to the background (ID: bx7) so that a message that arrived while it was running can reach you; ' +
            'it was not interrupted. Output is being written to: C:/T/tasks/bx7.output. You will be notified when it completes.',
        },
  )

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [LOOP] })
  await $.tool.call({ tool: 'Bash', command: 'npm run build' })
  let ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
  expect((await ui.find(COUNT))?.text).toBe('2 background tasks running')
  await ui.unmount()

  await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'y', run_in_background: true })
  ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
  expect((await ui.find(COUNT))?.text).toBe('3 background tasks running')
  await ui.unmount()
})

test('the commands counter: green while a command runs, grey once it returned, on every surface', async ($, on) => {
  const seen: { text?: string; color?: unknown }[] = []
  let surface: 'terminal' | 'desktop' = 'terminal'
  on('classic.Stop', async () => ({}))
  on('tool.call', async () => {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
    const found = await ui.find(CMDS)
    seen.push({ text: found?.text, color: found?.props.color })
    await ui.unmount()
    return { result: {}, text: 'done' }
  })

  for (const s of ['terminal', 'desktop'] as const) {
    surface = s
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [LOOP] })
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: s, ...BAND })
    const after = await ui.find(CMDS)
    expect(after?.text).toBe('0 commands running')
    expect(after?.props.color).toBe('inactive')
    await ui.unmount()
  }
  expect(seen).toEqual([
    { text: '1 command running', color: 'success' },
    { text: '1 command running', color: 'success' },
  ])
})

test('the button folds the band to itself, in its own place, and back', async ($, on) => {
  on('classic.Stop', async () => ({}))
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [SHELL], session_crons: [LOOP] })
  const band = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
  expect((await band.find({ key: 'toggle' }))?.props.label).toBe('Hide')
  expect((await band.find({ type: 'Text', text: '▼' }))?.props.color).toBe('claude')
  await band.press({ key: 'toggle' })
  expect(await band.find(COUNT)).toBeUndefined()
  expect(await band.find(CMDS)).toBeUndefined()
  expect(await band.find(QUESTIONS)).toBeUndefined()
  expect((await band.find({ key: 'toggle' }))?.props.label).toBe('Show')
  expect((await band.find({ type: 'Text', text: '▶' }))?.props.color).toBe('claude')
  await band.press({ key: 'toggle' })
  expect((await band.find(COUNT))?.text).toBe('2 background tasks running')
  await band.unmount()
})

test('writing a command: brown from its first streamed piece until it runs, its own dot, gone after', async ($, on) => {
  on('classic.Stop', async () => ({}))
  on('tool.call', async () => ({ result: {}, text: 'done' }))
  on('turn.step', async function* () {
    yield { kind: 'text', index: 0, text: 'Running a check.' }
    yield { kind: 'tool', index: 1, id: 'tu1', name: 'Bash' }
    yield { kind: 'input', index: 1, json: '{"command":"ls"}' }
    yield { kind: 'stop', stopReason: 'tool_use', usage: null }
    return {
      turnId: 't',
      index: 0,
      answer: 'Running a check.',
      toolUses: [{ id: 'tu1', name: 'Bash', input: { command: 'ls' } }],
      stopReason: 'tool_use',
      usage: null,
    }
  })

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [LOOP] })
  let ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
  expect(await ui.find(WRITING)).toBeUndefined()
  await ui.unmount()

  const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 })
  await stream.next()
  await stream.next()
  ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
  const w = await ui.find(WRITING)
  expect(w?.text).toBe('writing a command')
  expect(w?.props.color).toBe('#9C6644')
  expect((await ui.findAll({ type: 'Text', text: '·' })).length).toBe(2)
  await ui.unmount()
  let r = await stream.next()
  while (!r.done) {
    r = await stream.next()
  }

  await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'tu1' } as never)
  ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
  expect(await ui.find(WRITING)).toBeUndefined()
  expect((await ui.findAll({ type: 'Text', text: '·' })).length).toBe(1)
  await ui.unmount()
})

const QTEXT = [
  '# Questions waiting',
  '- [ ] 2026-10-14 20:30 · the release · ship today or tomorrow?',
  '- [x] 2026-10-14 18:52 · the README wording (answered)',
  '- [ ] 2026-10-14 20:31 · the old build folders · delete 26 GB of them?',
  '',
].join('\n')

test('the questions counter: counted from the file, yellow while any waits, white at zero, the list on a press', WITH_QFILE, async ($, on) => {
  let qtext: string | null = QTEXT
  let qtime = 1
  const asked: string[] = []
  on('classic.Stop', async () => ({}))
  on('fs.stat', async ($, e) => {
    asked.push(String(e.path))
    if (isQ(e.path) && qtext === null) {
      throw new Error('ENOENT')
    }
    return { value: { kind: 'file', size: (qtext ?? '').length, mtimeMs: qtime, isLink: false } }
  })
  on('fs.read', async ($, e) => ({ value: isQ(e.path) ? (qtext ?? '') : '' }))

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [LOOP] })
  let ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
  expect(asked.some(isQ)).toBe(true)
  let q = await ui.find(QUESTIONS)
  expect(q?.text).toBe('2 questions waiting')
  // from 1: plain text in the calm yellow (a desktop paints a button's text white), a short List button beside it
  expect(q?.props.color).toBe('#E5C07B')
  expect((await ui.find({ key: 'questions' }))?.props.label).toBe('List')
  expect((await ui.find({ key: 'questionsRow' }))?.props.columnGap).toBe(0.4)
  expect(await ui.find({ type: 'Text', text: /ship today/ })).toBeUndefined()
  await ui.press({ key: 'questions' })
  expect((await ui.find({ type: 'Text', text: /ship today/ }))?.text).toBe('1. 2026-10-14 20:30 · the release · ship today or tomorrow?')
  expect((await ui.find({ type: 'Text', text: /26 GB/ }))?.props.color).toBe('warning')
  expect(await ui.find({ type: 'Text', text: /answered/ })).toBeUndefined()
  expect((await ui.find({ key: 'questions' }))?.props.label).toBe('Close')
  await ui.press({ key: 'questions' })
  expect(await ui.find({ type: 'Text', text: /ship today/ })).toBeUndefined()
  await ui.unmount()

  qtext = '- [x] 2026-10-14 20:30 · the release · ship today or tomorrow? - today\n'
  qtime = 2
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [LOOP] })
  ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
  q = await ui.find(QUESTIONS)
  expect(q?.text).toBe('0 questions waiting')
  // at 0: white plain text (the theme's own text colour), with the same List button beside it
  expect(q?.props.color).toBe('text')
  expect((await ui.find({ key: 'questions' }))?.props.label).toBe('List')
  expect(await ui.find({ type: 'Text', text: /question waits/ })).toBeUndefined()
  await ui.press({ key: 'questions' })
  expect((await ui.find({ type: 'Text', text: /question waits/ }))?.text).toBe('No question waits')
  await ui.press({ key: 'questions' })
  await ui.unmount()

  qtext = null
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [LOOP] })
  ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
  expect((await ui.find(QUESTIONS))?.text).toBe('0 questions waiting')
  await ui.unmount()
})

test('the questions list never outgrows the band: past its rows the rest are counted', WITH_QFILE, async ($, on) => {
  const many = ['- [ ] a', '- [ ] b', '- [ ] c', '- [ ] d'].join('\n') + '\n'
  on('classic.Stop', async () => ({}))
  on('fs.stat', async () => ({ value: { kind: 'file', size: many.length, mtimeMs: 7, isLink: false } }))
  on('fs.read', async ($, e) => ({ value: isQ(e.path) ? many : '' }))

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [LOOP] })
  const small = { ...BAND, props: { ...BAND.props, maxRows: 4 } }
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...small })
  expect((await ui.find(QUESTIONS))?.text).toBe('4 questions waiting')
  await ui.press({ key: 'questions' })
  expect((await ui.find({ type: 'Text', text: /^1\. a$/ }))?.text).toBe('1. a')
  expect(await ui.find({ type: 'Text', text: /^2\. b$/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /and \d+ more/ }))?.text).toBe(`… and 3 more in ${QFILE}`)
  await ui.unmount()
})

test('the note to Claude: one session section naming the questions file, unless turned off', WITH_QFILE, async ($, on) => {
  on('prompt.compose', async () => ({ sections: [{ id: 'intro', text: 'the engine prompt', scope: 'shared' as const }] }))
  const r = await $.prompt.compose(FACTS as never)
  const note = r.sections.find(s => s.id === 'glance-band:questions')
  expect(note?.scope).toBe('session')
  expect(note?.text.includes(QFILE)).toBe(true)
  expect(note?.text.includes('- [ ] YYYY-MM-DD HH:MM')).toBe(true)
  expect(r.sections[0].id).toBe('intro')
})

test('the note to Claude stays out when teach_claude is off', { options: { questions_file: QFILE, teach_claude: false } }, async ($, on) => {
  on('prompt.compose', async () => ({ sections: [{ id: 'intro', text: 'the engine prompt', scope: 'shared' as const }] }))
  const r = await $.prompt.compose(FACTS as never)
  expect(r.sections.find(s => s.id === 'glance-band:questions')).toBeUndefined()
  expect(r.sections.length).toBe(1)
})

test('nothing drawn before the first turn ends, nor over a survey', async ($, on) => {
  on('classic.Stop', async () => ({}))
  // stands for the engine's own band (what next(e) reaches when the plugin draws nothing)
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  let ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
  expect(await ui.find(COUNT)).toBeUndefined()
  await ui.unmount()

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [SHELL], session_crons: [] })
  ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND, props: { ...BAND.props, hasSurvey: true } })
  expect(await ui.find(COUNT)).toBeUndefined()
  await ui.unmount()
})
