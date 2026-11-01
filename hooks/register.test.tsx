import { expect, mock, test } from 'claude-code/testing'

const PLUGIN = 'glance-band'
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const

const COUNT = { type: 'Text', text: /background tasks? running/ } as const
const CMDS = { type: 'Text', text: /commands? running/ } as const
const WRITING = { type: 'Text', text: /writing (a|\d+) commands?/ } as const
const QUESTIONS = { type: 'Text', text: /questions? waiting: this session/ } as const
const OTHERS = { type: 'Text', text: /questions? waiting: other sessions/ } as const

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

const SEARCH = { type: 'Text', text: /searching|searches/ } as const

test('searching: brown while a Grep or a Glob runs, its own dot, the commands untouched, two counted, gone after', async ($, on) => {
  const during: { text?: string; color?: unknown; dots: number; cmds?: string }[] = []
  let second = false
  on('classic.Stop', async () => ({}))
  on('tool.call', async (_$, e) => {
    const tool = (e as { tool?: string }).tool
    if (tool === 'Grep' && second) {
      second = false
      await $.tool.call({ tool: 'Glob', pattern: '**/*.md' })  // a second search while the first still runs
    }
    if (tool === 'Grep' || tool === 'Glob') {
      const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
      const s = await ui.find(SEARCH)
      const dots = (await ui.findAll({ type: 'Text', text: '·' })).length
      during.push({ text: s?.text, color: s?.props.color, dots, cmds: (await ui.find(CMDS))?.text })
      await ui.unmount()
    }
    return { result: {}, text: 'done' }
  })

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [LOOP] })
  let ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
  expect(await ui.find(SEARCH)).toBeUndefined()
  await ui.unmount()

  await $.tool.call({ tool: 'Grep', pattern: 'TODO' })
  await $.tool.call({ tool: 'Glob', pattern: '**/*.md' })
  second = true
  await $.tool.call({ tool: 'Grep', pattern: 'FIXME' })
  const one = { text: 'searching', color: '#9C6644', dots: 2, cmds: '0 commands running' }
  expect(during).toEqual([one, one, { ...one, text: 'running 2 searches' }, one])

  ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
  expect(await ui.find(SEARCH)).toBeUndefined()
  expect((await ui.findAll({ type: 'Text', text: '·' })).length).toBe(1)
  await ui.unmount()
})

// Claude Code sometimes runs a call as soon as it is written and sometimes holds several of one reply until the last
// is written; the harness runs no call while a reply is still being written, so the held state is handed to it whole:
// the reply's pieces first, then the calls
test('creating, rewriting and editing: each kind counted, all on one line, the same brown, a command running beside them', async ($, on) => {
  const during: string[][] = []
  const asked: string[] = []
  const texts = async () => {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
    const t = (await ui.findAll({ type: 'Text' })).map(x => String(x.text))
    await ui.unmount()
    return t
  }
  on('classic.Stop', async () => ({}))
  // one file already exists: C:\x\old.txt (its name arrives JSON-escaped, and in two pieces)
  on('fs.exists', async (_$, e) => {
    const p = String((e as { path?: string }).path)
    asked.push(p)
    return { value: p === 'C:\\x\\old.txt' }
  })
  on('tool.call', async (_$, e) => {
    if ((e as { tool?: string }).tool === 'Bash') {
      during.push(await texts())  // the band while the command runs
    }
    return { result: {}, text: 'done' }
  })
  on('turn.step', async function* () {
    yield { kind: 'tool', index: 0, id: 'c1', name: 'Bash' }
    yield { kind: 'tool', index: 1, id: 'w1', name: 'Write' }
    yield { kind: 'input', index: 1, json: '{"file_path": "C:\\\\x\\\\new.txt", "content": "x"}' }
    yield { kind: 'tool', index: 2, id: 'w2', name: 'Write' }
    yield { kind: 'input', index: 2, json: '{"file_pa' }
    yield { kind: 'input', index: 2, json: 'th": "C:\\\\x\\\\old.txt", "content": "y"}' }
    yield { kind: 'tool', index: 3, id: 'e1', name: 'Edit' }
    yield { kind: 'tool', index: 4, id: 'e2', name: 'Edit' }
    yield { kind: 'tool', index: 5, id: 'e3', name: 'Edit' }
    yield { kind: 'tool', index: 6, id: 'r1', name: 'Read' }
    yield { kind: 'stop', stopReason: 'tool_use', usage: null }
    return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', usage: null }
  })

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [LOOP] })
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 })
  let r = await stream.next()
  while (!r.done) {
    r = await stream.next()
  }
  // all held: a command, a new file, an existing file and three edits - one line; reading never shown
  expect(asked).toEqual(['C:\\x\\new.txt', 'C:\\x\\old.txt'])
  const held = await texts()
  expect(held).toContain('writing a command')
  expect(held).toContain('creating a file')
  expect(held).toContain('rewriting a file')
  expect(held).toContain('making 3 edits')
  expect(held.some(t => /reading|editing 3/.test(t))).toBe(false)
  expect(held).not.toContain('writing a file')
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
  expect((await ui.find({ type: 'Text', text: 'creating a file' }))?.props.color).toBe('#9C6644')
  expect((await ui.find({ type: 'Text', text: 'rewriting a file' }))?.props.color).toBe('#9C6644')
  expect((await ui.find({ type: 'Text', text: 'making 3 edits' }))?.props.color).toBe('#9C6644')
  expect((await ui.findAll({ type: 'Text', text: '·' })).length).toBe(5)
  await ui.unmount()

  // the command runs: "1 command running" beside the files and the edits still being written, its own label gone
  await $.tool.call({ tool: 'Bash', command: 'sleep 4', tool_use_id: 'c1' } as never)
  expect(during[0]).toContain('1 command running')
  expect(during[0]).toContain('creating a file')
  expect(during[0]).toContain('rewriting a file')
  expect(during[0]).toContain('making 3 edits')
  expect(during[0].some(t => /writing a command/.test(t))).toBe(false)

  // each goes as it runs: the two files, then two edits - one edit left reads "editing a file"
  await $.tool.call({ tool: 'Write', file_path: 'C:\\x\\new.txt', content: 'x', tool_use_id: 'w1' } as never)
  await $.tool.call({ tool: 'Write', file_path: 'C:\\x\\old.txt', content: 'y', tool_use_id: 'w2' } as never)
  await $.tool.call({ tool: 'Edit', file_path: 'a.txt', old_string: 'x', new_string: 'y', tool_use_id: 'e1' } as never)
  await $.tool.call({ tool: 'Edit', file_path: 'a.txt', old_string: 'y', new_string: 'z', tool_use_id: 'e2' } as never)
  const one = await texts()
  expect(one).toContain('editing a file')
  expect(one.some(t => /creating|rewriting|edits/.test(t))).toBe(false)
  await $.tool.call({ tool: 'Edit', file_path: 'a.txt', old_string: 'z', new_string: 'w', tool_use_id: 'e3' } as never)
  expect((await texts()).some(t => /writing|creating|editing|edits/.test(t))).toBe(false)
})

// one file, one section per session (1.2.0): this test's session is S1; S2 is another session, and the line above
// every section was written before the sections began - both another session's
const QTEXT = [
  '# Questions waiting',
  '- [ ] 2026-10-13 09:00 · before the sections · an old open one',
  '',
  '## session S1',
  '- [ ] 2026-10-14 20:30 · the release · ship today or tomorrow?',
  '- [x] 2026-10-14 18:52 · the README wording (answered)',
  '- [ ] 2026-10-14 20:31 · the old build folders · delete 26 GB of them?',
  '<!-- end of session S1 -->',
  '',
  '## session S2',
  '- [ ] 2026-10-14 21:00 · the other work · the other session\'s question',
  '<!-- end of session S2 -->',
  '',
].join('\n')

test('the questions counter: this session and the other sessions apart, yellow while any waits, the list this session\'s', WITH_QFILE, async ($, on) => {
  let qtext: string | null = QTEXT
  let qtime = 1
  const asked: string[] = []
  on('session.id', async () => ({ value: 'S1' }))
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
  expect(q?.text).toBe('2 questions waiting: this session')
  // the other sessions' count beside it: S2's line and the one outside every section
  expect((await ui.find(OTHERS))?.text).toBe('2 questions waiting: other sessions')
  expect((await ui.find(OTHERS))?.props.color).toBe('#E5C07B')
  expect((await ui.find({ type: 'Text', text: /^; $/ }))?.text).toBe('; ')
  // from 1: plain text in the calm yellow (a desktop paints a button's text white), a short List button beside it
  expect(q?.props.color).toBe('#E5C07B')
  expect((await ui.find({ key: 'questions' }))?.props.label).toBe('List')
  expect((await ui.find({ key: 'questionsRow' }))?.props.columnGap).toBe(0.4)
  expect(await ui.find({ type: 'Text', text: /ship today/ })).toBeUndefined()
  await ui.press({ key: 'questions' })
  expect((await ui.find({ type: 'Text', text: /ship today/ }))?.text).toBe('1. 2026-10-14 20:30 · the release · ship today or tomorrow?')
  expect((await ui.find({ type: 'Text', text: /26 GB/ }))?.props.color).toBe('warning')
  expect(await ui.find({ type: 'Text', text: /answered/ })).toBeUndefined()
  // the list is this session's alone
  expect(await ui.find({ type: 'Text', text: /other session's question/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /an old open one/ })).toBeUndefined()
  expect((await ui.find({ key: 'questions' }))?.props.label).toBe('Close')
  await ui.press({ key: 'questions' })
  expect(await ui.find({ type: 'Text', text: /ship today/ })).toBeUndefined()
  await ui.unmount()

  qtext = [
    '## session S1', '- [x] 2026-10-14 20:30 · the release · ship today or tomorrow? - today', '<!-- end of session S1 -->',
    '## session S2', '- [ ] 2026-10-14 21:00 · the other work · the other session\'s question', '<!-- end of session S2 -->', '',
  ].join('\n')
  qtime = 2
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [LOOP] })
  ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
  q = await ui.find(QUESTIONS)
  expect(q?.text).toBe('0 questions waiting: this session')
  // at 0: white plain text (the theme's own text colour), with the same List button beside it; the other sessions'
  // 1 stays yellow
  expect(q?.props.color).toBe('text')
  expect((await ui.find(OTHERS))?.text).toBe('1 question waiting: other sessions')
  expect((await ui.find(OTHERS))?.props.color).toBe('#E5C07B')
  expect((await ui.find({ key: 'questions' }))?.props.label).toBe('List')
  expect(await ui.find({ type: 'Text', text: /question waits/ })).toBeUndefined()
  await ui.press({ key: 'questions' })
  expect((await ui.find({ type: 'Text', text: /question waits/ }))?.text).toBe('No question waits')
  await ui.press({ key: 'questions' })
  await ui.unmount()

  qtext = null
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [LOOP] })
  ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
  expect((await ui.find(QUESTIONS))?.text).toBe('0 questions waiting: this session')
  expect((await ui.find(OTHERS))?.text).toBe('0 questions waiting: other sessions')
  expect((await ui.find(OTHERS))?.props.color).toBe('text')
  await ui.unmount()
})

test('the questions list never outgrows the band: past its rows the rest are counted', WITH_QFILE, async ($, on) => {
  const many = ['## session S1', '- [ ] a', '- [ ] b', '- [ ] c', '- [ ] d', '<!-- end of session S1 -->'].join('\n') + '\n'
  on('session.id', async () => ({ value: 'S1' }))
  on('classic.Stop', async () => ({}))
  on('fs.stat', async () => ({ value: { kind: 'file', size: many.length, mtimeMs: 7, isLink: false } }))
  on('fs.read', async ($, e) => ({ value: isQ(e.path) ? many : '' }))

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [LOOP] })
  const small = { ...BAND, props: { ...BAND.props, maxRows: 5 } }
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...small })
  expect((await ui.find(QUESTIONS))?.text).toBe('4 questions waiting: this session')
  await ui.press({ key: 'questions' })
  expect((await ui.find({ type: 'Text', text: /^1\. a$/ }))?.text).toBe('1. a')
  expect(await ui.find({ type: 'Text', text: /^2\. b$/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /and \d+ more/ }))?.text).toBe(`… and 3 more in ${QFILE}`)
  await ui.unmount()
})

test('the note to Claude: one session section naming the questions file and THIS session\'s section, unless turned off', WITH_QFILE, async ($, on) => {
  on('session.id', async () => ({ value: 'S1' }))
  on('prompt.compose', async () => ({ sections: [{ id: 'intro', text: 'the engine prompt', scope: 'shared' as const }] }))
  const r = await $.prompt.compose(FACTS as never)
  const note = r.sections.find(s => s.id === 'glance-band:questions')
  expect(note?.scope).toBe('session')
  expect(note?.text.includes(QFILE)).toBe(true)
  expect(note?.text.includes('- [ ] YYYY-MM-DD HH:MM')).toBe(true)
  // the session's id, its two section lines, and the rule to ask only this section's questions
  expect(note?.text.includes('THIS SESSION\'S ID IS S1')).toBe(true)
  expect(note?.text.includes('"## session S1" and "<!-- end of session S1 -->"')).toBe(true)
  expect(note?.text.includes('Ask the user only the questions in this session\'s section')).toBe(true)
  expect(r.sections[0].id).toBe('intro')
})

test('the note to Claude stays out when teach_claude is off', { options: { questions_file: QFILE, teach_claude: false } }, async ($, on) => {
  on('prompt.compose', async () => ({ sections: [{ id: 'intro', text: 'the engine prompt', scope: 'shared' as const }] }))
  const r = await $.prompt.compose(FACTS as never)
  expect(r.sections.find(s => s.id === 'glance-band:questions')).toBeUndefined()
  expect(r.sections.length).toBe(1)
})

const OTHER_TASKS = { type: 'Text', text: /Background tasks? running: other sessions/ } as const
const HOME = 'C:/glance-test/home'
const TOLD_DIR = `${HOME}/.claude/band_tasks`
const PINK = '#F48FB1'
type Told = { text: string; mtimeMs: number }
// the engine hands a hook the platform's own spelling of a path
const slashed = (p: unknown) => String(p).replace(/\\/g, '/')
// a band_tasks folder in memory, answering the band's three calls on it as the disk would
const toldFolder = (on: Parameters<Parameters<typeof test>[1]>[1], disk: Map<string, Told>, now: () => number) => {
  on('fs.write', async (_$, e) => {
    disk.set(slashed(e.path), { text: String(e.text), mtimeMs: now() })
    return { value: undefined }
  })
  on('fs.list', async (_$, e) => ({
    value: [...disk]
      .filter(([p]) => p.startsWith(`${slashed(e.path)}/`))
      .map(([p, f]) => ({ name: p.slice(slashed(e.path).length + 1), kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false })),
  }))
  on('fs.read', async (_$, e) => ({ value: disk.get(slashed(e.path))?.text ?? '' }))
}

// This test's session is S1: S2 and S3 are other sessions still telling, S4 has gone silent (a session that ended with
// tasks on its count), and S1's own file is never its own "other"
test('the other sessions\' tasks: directly under the first row, pink from 1, grey at 0, this session\'s own and a silent one left out', async ($, on) => {
  const clock = mock.clock(on, { now: 100_000 })
  mock.env(on, { HOME })
  const disk = new Map<string, Told>([
    [`${TOLD_DIR}/S1.txt`, { text: '5\n', mtimeMs: 99_000 }],
    [`${TOLD_DIR}/S2.txt`, { text: '2\n', mtimeMs: 95_000 }],
    [`${TOLD_DIR}/S3.txt`, { text: '1\n', mtimeMs: 99_000 }],
    [`${TOLD_DIR}/S4.txt`, { text: '7\n', mtimeMs: 60_000 }],
    [`${TOLD_DIR}/garbled.txt`, { text: 'not a number', mtimeMs: 99_000 }],
  ])
  on('session.id', async () => ({ value: 'S1' }))
  on('classic.Stop', async () => ({}))
  toldFolder(on, disk, clock.now)
  const stop = () => $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [LOOP] })

  for (const surface of ['terminal', 'desktop'] as const) {
    await stop()
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
    const row = await ui.find(OTHER_TASKS)
    expect(row?.text).toBe('3 Background tasks running: other sessions')
    expect(row?.props.color).toBe(PINK)
    // directly under the first row, whose last piece is the Hide button's triangle, and directly above the questions
    const texts = (await ui.findAll({ type: 'Text' })).map(x => String(x.text))
    const at = texts.findIndex(t => /Background/.test(t))
    expect(texts[at - 1]).toBe('▼')
    expect(texts[at + 1]).toMatch(/waiting: this session/)
    await ui.unmount()
  }

  // S3 goes silent, S2 keeps telling, now 1: the row's own singular, still pink
  await clock.advance(31_000)
  disk.set(`${TOLD_DIR}/S2.txt`, { text: '1\n', mtimeMs: clock.now() })
  await stop()
  let ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
  expect((await ui.find(OTHER_TASKS))?.text).toBe('1 Background task running: other sessions')
  expect((await ui.find(OTHER_TASKS))?.props.color).toBe(PINK)
  await ui.unmount()

  // S2 says 0: grey, the row stays
  disk.set(`${TOLD_DIR}/S2.txt`, { text: '0\n', mtimeMs: clock.now() })
  await stop()
  ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
  expect((await ui.find(OTHER_TASKS))?.text).toBe('0 Background tasks running: other sessions')
  expect((await ui.find(OTHER_TASKS))?.props.color).toBe('inactive')

  // folded, only the button stays
  await ui.press({ key: 'toggle' })
  expect(await ui.find(OTHER_TASKS)).toBeUndefined()
  await ui.unmount()
})

test('no home folder known and no band_tasks folder yet read as 0, grey, write nothing and take nothing else down', async ($, on) => {
  mock.clock(on, { now: 100_000 })
  const writes: string[] = []
  on('classic.Stop', async () => ({}))
  on('session.id', async () => ({ value: 'S1' }))
  on('fs.write', async (_$, e) => {
    writes.push(slashed(e.path))
    return { value: undefined }
  })
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [SHELL], session_crons: [] })
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
  expect((await ui.find(OTHER_TASKS))?.text).toBe('0 Background tasks running: other sessions')
  expect((await ui.find(OTHER_TASKS))?.props.color).toBe('inactive')
  expect((await ui.find(COUNT))?.text).toBe('1 background task running')
  expect(writes).toEqual([])
  await ui.unmount()
})

test('the folder is found under USERPROFILE too', async ($, on) => {
  mock.clock(on, { now: 100_000 })
  const writes: string[] = []
  mock.env(on, { USERPROFILE: 'C:\\glance-test\\home\\' })
  on('session.id', async () => ({ value: 'S1' }))
  on('classic.Stop', async () => ({}))
  on('fs.write', async (_$, e) => {
    writes.push(slashed(e.path))
    return { value: undefined }
  })
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [SHELL], session_crons: [] })
  expect(writes).toEqual([`${TOLD_DIR}/S1.txt`])
})

test('this session\'s own file: nothing before a first task, written when its number moves, again every ten seconds, 0 said once', async ($, on) => {
  const clock = mock.clock(on, { now: 500_000 })
  mock.env(on, { HOME })
  const writes: string[] = []
  on('session.id', async () => ({ value: 'S1' }))
  on('classic.Stop', async () => ({}))
  on('fs.write', async (_$, e) => {
    writes.push(`${slashed(e.path)} ${JSON.stringify(e.text)} @${clock.now()}`)
    return { value: undefined }
  })
  const stop = (tasks: unknown[], crons: unknown[]) =>
    $.classic.Stop({ stop_hook_active: false, background_tasks: tasks, session_crons: crons } as never)
  const FILE = `${TOLD_DIR}/S1.txt`

  // a session that never ran a task leaves no file
  await stop([], [])
  await stop([], [])
  await clock.advance(30_000)
  await stop([], [])
  expect(writes).toEqual([])

  // the number moves: told at once, the loop counted as the first row counts it
  await stop([SHELL], [LOOP])
  expect(writes).toEqual([`${FILE} "2\\n" @530000`])

  // unmoved inside the beat: nothing; past it: told again, so the others can tell it from a session that ended
  await clock.advance(9_999)
  await stop([SHELL], [LOOP])
  expect(writes.length).toBe(1)
  await clock.advance(1)
  await stop([SHELL], [LOOP])
  expect(writes.length).toBe(2)
  expect(writes[1]).toBe(`${FILE} "2\\n" @540000`)

  // the shell moved the timer to work: from here the tick alone beats, with no turn ending
  await clock.advance(10_000)
  expect(writes.length).toBe(3)
  await clock.advance(10_000)
  expect(writes.length).toBe(4)

  // back to 0: said once, then silence
  await stop([], [])
  expect(writes.length).toBe(5)
  expect(writes[4]).toMatch(/S1\.txt "0\\n" @/)
  await clock.advance(60_000)
  await stop([], [])
  expect(writes.length).toBe(5)
})

test('one band\'s file as it writes it is what another band reads, and the session gone silent leaves the row', async ($, on) => {
  const clock = mock.clock(on, { now: 100_000 })
  mock.env(on, { HOME })
  const disk = new Map<string, Told>()
  let me = 'S1'
  on('session.id', async () => ({ value: me }))
  on('classic.Stop', async () => ({}))
  toldFolder(on, disk, clock.now)

  // S1 runs a shell and a loop and tells it
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [SHELL], session_crons: [LOOP] })
  let ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
  // its own number is never its own "other"
  expect((await ui.find(OTHER_TASKS))?.text).toBe('0 Background tasks running: other sessions')
  await ui.unmount()

  // the same band answering as S2, with nothing of its own running: S1's 2 is an other session's
  me = 'S2'
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [] })
  ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
  expect((await ui.find(OTHER_TASKS))?.text).toBe('2 Background tasks running: other sessions')
  expect((await ui.find(OTHER_TASKS))?.props.color).toBe(PINK)
  expect((await ui.find(COUNT))?.text).toBe('0 background tasks running')
  await ui.unmount()

  // S1 says no more: at 29 seconds still counted, at 30 gone - the last moved by the tick alone, no turn ending (an idle
  // session's row must move too; the 2-second tick stands at an even second, so the clock goes to 31 and stays there)
  await clock.advance(29_000)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [] })
  ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
  expect((await ui.find(OTHER_TASKS))?.text).toBe('2 Background tasks running: other sessions')
  await ui.unmount()
  await clock.advance(3_000)
  ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
  expect((await ui.find(OTHER_TASKS))?.text).toBe('0 Background tasks running: other sessions')
  expect((await ui.find(OTHER_TASKS))?.props.color).toBe('inactive')
  await ui.unmount()
})

test('with other_sessions_tasks off nothing is written or read there and the row is not drawn', { options: { other_sessions_tasks: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: 100_000 })
  mock.env(on, { HOME })
  const asked: string[] = []
  on('session.id', async () => ({ value: 'S1' }))
  on('classic.Stop', async () => ({}))
  on('fs.write', async (_$, e) => {
    asked.push(`write ${slashed(e.path)}`)
    return { value: undefined }
  })
  on('fs.list', async (_$, e) => {
    asked.push(`list ${slashed(e.path)}`)
    return { value: [] }
  })
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [SHELL], session_crons: [LOOP] })
  await clock.advance(20_000)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
  expect(await ui.find(OTHER_TASKS)).toBeUndefined()
  expect((await ui.find(COUNT))?.text).toBe('2 background tasks running')
  expect(asked).toEqual([])
  await ui.unmount()
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
