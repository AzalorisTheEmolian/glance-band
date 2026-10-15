import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnStepChunk, TurnStepResult } from 'claude-code'

import type { Counts, Watched } from '../types'

// GLANCE BAND - one band above the prompt that says, at a glance, what Claude Code is doing and whether a question of
// Claude's is waiting for you.
//
// Row 1: the session's background work and scheduled loops - "N background tasks running", blue while any run, grey at
// zero, lilac when the only thing running is a loop - then the shell commands running right now (green while any run)
// and "writing a command" (brown) while Claude is still writing one; Hide folds the band down to its Show button.
// Row 2: "N questions waiting" - white at zero, a calm yellow from one - counted from ONE Markdown file, with a List
// button that unfolds the open questions under it.
//
// HOW THE COUNTS STAY TRUE. The session's own Stop event at every turn's end carries its in-flight background tasks and
// its scheduled jobs: the whole truth, once a turn. Between turn ends the band moves live: a background launch, a
// TaskStop, a CronCreate or a CronDelete counts the moment its tool call returns, and every two seconds the output file
// of each running background shell is read for the line Claude Code writes when a shell ends - "[killed]" (a stop from
// the tasks panel too, which raises no event a plugin can hear) or "[exited with code N]".
// (each atom names the plugin as a literal: the engine reads the state a module keeps from its source)
const PLUGIN = 'glance-band'
const counts = atom({ plugin: 'glance-band', key: 'counts' } as const, null)
const watch = atom({ plugin: 'glance-band', key: 'watch' } as const, [])
const dir = atom({ plugin: 'glance-band', key: 'dir' } as const, null)
const running = atom({ plugin: 'glance-band', key: 'running' } as const, 0)
const hidden = atom({ plugin: 'glance-band', key: 'hidden' } as const, false)
const writing = atom({ plugin: 'glance-band', key: 'writing' } as const, 0)
const questions = atom({ plugin: 'glance-band', key: 'questions' } as const, [])
const showQuestions = atom({ plugin: 'glance-band', key: 'showQuestions' } as const, false)

const COMMANDS = ['Bash', 'PowerShell']
// work that runs in the background with no output file to watch: it counts at its launch and leaves at a turn's end
const BACKGROUND_TOOLS = ['Workflow', 'Monitor']
const ENDED = ['completed', 'failed', 'killed', 'stopped', 'cancelled']
const POLL_MS = 2000
const END_MARK = /\[(killed|exited with code -?\d+)\]\s*$/
// a shell sent to the background - asked for ("running in background with ID: X.") or moved there while it ran
// ("moved to the background (ID: X)") - and the output file it writes to
const LAUNCHED = /(?:running in background with ID: (\S+?)\.|moved to the background \(ID: (\S+?)\))[\s\S]*?Output is being written to: (\S.*?\.output)/

const LILAC = '#C8A2C8'
const ROAST = '#9C6644'
const GOLD = '#E5C07B'
const AMBER = 'warning'
const HIDE = '▼'
const SHOW = '▶'
// a mod spaces in character cells; a desktop's cell is its code font's advance, about 7 to 8 px - so about 3 px
const BUTTON_GAP = 0.4

// THE QUESTIONS FILE: every line "- [ ] ..." is a question waiting, every "- [x] ..." one answered. Its path is the
// `questions_file` option, or <home>/.claude/questions_waiting.md; unless the `teach_claude` option is off, a short
// section of the system prompt asks Claude to keep it (QUESTIONS_NOTE below).
const OPEN_QUESTION = /^- \[ \] (.+)$/gm
const DEFAULT_QUESTIONS = '/.claude/questions_waiting.md'

type Options = { questions_file?: string; teach_claude?: boolean }

const colorOf = (c: Counts) => (c.tasks + c.crons === 0 ? 'inactive' : c.tasks === 0 && c.crons === 1 ? LILAC : 'suggestion')

const QUESTIONS_NOTE = (path: string) =>
  [
    'The Glance Band plugin shows the user, above the prompt, how many of your questions wait for an answer, counted ' +
      'from one file: ' + path + '.',
    'Whenever you ask the user a question you need answered (a choice, a confirmation, a missing fact), add ONE line ' +
      'to that file in the same step: "- [ ] YYYY-MM-DD HH:MM · topic · the question" (create the file if it is missing).',
    'When the user answers it, or it stops mattering, change that line\'s "- [ ]" to "- [x]" and add the answer after it.',
    'Never keep a count of the questions anywhere else: the band counts the open lines itself.',
  ].join(' ')

// the module's own memory, reset at every load: what the shells' output files said last, whether the timer runs, and
// the questions file's path once resolved
const seen = new Map<string, number>()
let ticking = false
let questionsPath: string | null = null
const pending = new Set<string>()

const resolvePath = async ($: EngineInterface, options: Options) => {
  if (questionsPath !== null) {
    return questionsPath
  }
  const chosen = (options.questions_file ?? '').trim()
  if (chosen) {
    questionsPath = chosen
  } else {
    const home = (await $.env.get('HOME').catch(() => undefined)) ?? (await $.env.get('USERPROFILE').catch(() => undefined))
    questionsPath = home ? home.replace(/[\\/]+$/, '') + DEFAULT_QUESTIONS : ''
  }
  return questionsPath
}

// read whole at every tick (a small file), the band redrawn only when the list itself changed
const readQuestions = async ($: EngineInterface, options: Options) => {
  let open: string[] = []
  try {
    const path = await resolvePath($, options)
    if (path) {
      const s = await $.fs.stat(path)
      if (s.size <= 1_000_000) {
        open = [...String(await $.fs.read(path)).matchAll(OPEN_QUESTION)].map(m => m[1].trim())
      }
    }
  } catch {
    // no file is no question waiting
  }
  const now = await read($, questions)
  if (now.length !== open.length || now.some((q, i) => q !== open[i])) {
    await update($, questions, () => open)
  }
}

const setWriting = async ($: EngineInterface) => {
  const n = pending.size
  await update($, writing, () => n)
}

// passes the reply's stream through untouched, noting each shell command whose writing begins
async function* tap($: EngineInterface, stream: AsyncGenerator<TurnStepChunk, TurnStepResult>) {
  let step = await stream.next()
  while (!step.done) {
    const c = step.value
    if (c.kind === 'tool' && COMMANDS.includes(c.name)) {
      pending.add(c.id)
      await setWriting($).catch(() => undefined)
    }
    yield c
    step = await stream.next()
  }
  return step.value
}

const bump = async ($: EngineInterface, tasks: number, crons: number) => {
  await update($, counts, c => ({
    tasks: Math.max(0, (c?.tasks ?? 0) + tasks),
    crons: Math.max(0, (c?.crons ?? 0) + crons),
  }))
}

// takes the given shells off the watch and the count once each, whichever witness saw them end first
const drop = async ($: EngineInterface, ids: string[]) => {
  const present = (await read($, watch)).filter(t => ids.includes(t.id)).map(t => t.id)
  if (present.length === 0) {
    return
  }
  await update($, watch, ws => ws.filter(t => !present.includes(t.id)))
  await bump($, -present.length, 0)
}

const poll = async ($: EngineInterface, options: Options) => {
  const gone: string[] = []
  for (const t of await read($, watch)) {
    try {
      const s = await $.fs.stat(t.out)
      if (seen.get(t.out) === s.mtimeMs || s.size > 4_000_000) {
        continue
      }
      seen.set(t.out, s.mtimeMs)
      if (END_MARK.test(String(await $.fs.read(t.out)))) {
        gone.push(t.id)
      }
    } catch {
      // a file not there (yet, or any more) says nothing; the next turn's end corrects the count
    }
  }
  if (gone.length) {
    await drop($, gone)
  }
  await readQuestions($, options)
}

const tick = ($: EngineInterface, options: Options) => {
  if (ticking) {
    return
  }
  ticking = true
  $.clock.every(POLL_MS, () => {
    void poll($, options).catch(() => undefined)
  })
}

export const register: Register = (on, rawOptions) => {
  const options = (rawOptions ?? {}) as Options

  on('session.start', async ($, e, next) => {
    // a way back that never depends on a drawing: /band folds the band and unfolds it
    await $.command
      .register({ name: 'band', description: 'Show or hide the Glance Band above the prompt', immediate: true })
      .catch(() => undefined)
    await readQuestions($, options)
    tick($, options)
    return next(e)
  })

  on('command.run', { command: 'band' }, async $ => {
    await update($, hidden, folded => !folded)
    return { text: (await read($, hidden)) ? 'The band is folded - /band or its Show button brings it back.' : 'The band is shown.' }
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (options.teach_claude === false) {
      return r
    }
    const path = await resolvePath($, options).catch(() => '')
    if (!path) {
      return r
    }
    return { sections: [...r.sections, { id: `${PLUGIN}:questions`, text: QUESTIONS_NOTE(path), scope: 'session' as const }] }
  })

  on('classic.Stop', async ($, e, next) => {
    const live = (e.background_tasks ?? []).filter(t => !ENDED.includes(String(t.status).toLowerCase()))
    const crons = (e.session_crons ?? []).length
    const now: Counts = { tasks: live.length, crons }
    await update($, counts, () => now)
    await update($, running, () => 0)
    pending.clear()
    await update($, writing, () => 0)
    await readQuestions($, options)

    const d = await read($, dir)
    const shells = live.filter(t => t.type === 'shell').map(t => t.id)
    await update($, watch, ws => {
      const known = new Map(ws.map(t => [t.id, t.out]))
      return shells.flatMap((id): Watched[] => {
        const out = known.get(id) ?? (d ? `${d}/${id}.output` : null)
        return out ? [{ id, out }] : []
      })
    })
    if (shells.length) {
      tick($, options)
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    return yield* tap($, next(e))
  })

  on('tool.call', async ($, e, next) => {
    if (pending.delete(e.tool_use_id)) {
      await setWriting($).catch(() => undefined)
    }
    const isCommand = COMMANDS.includes(e.tool)
    if (isCommand) {
      await update($, running, n => n + 1).catch(() => undefined)
    }
    const r = await next(e).finally(() => (isCommand ? update($, running, n => Math.max(0, n - 1)).catch(() => undefined) : undefined))
    try {
      if (r.deny || r.isError) {
        return r
      }
      const launched = LAUNCHED.exec(r.text ?? '')
      const input = e as unknown as { run_in_background?: boolean; task_id?: string; shell_id?: string }
      if (launched) {
        const id = launched[1] ?? launched[2]
        const out = launched[3]
        await update($, dir, () => out.replace(/[\\/][^\\/]+$/, ''))
        await update($, watch, ws => [...ws.filter(t => t.id !== id), { id, out }])
        await bump($, 1, 0)
        tick($, options)
      } else if (input.run_in_background === true || BACKGROUND_TOOLS.includes(e.tool)) {
        await bump($, 1, 0)
      } else if (e.tool === 'TaskStop') {
        const id = input.task_id ?? input.shell_id
        if (id) {
          await drop($, [id])
        }
      } else if (e.tool === 'CronCreate') {
        await bump($, 0, 1)
      } else if (e.tool === 'CronDelete') {
        await bump($, 0, -1)
      }
    } catch {
      // the band never stands in a tool's way; the next turn's end corrects the count
    }
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const c = await read($, counts)
    if (e.props.hasSurvey || c === null) {
      return next(e)
    }

    const n = c.tasks + c.crons
    const label = n === 1 ? '1 background task running' : `${n} background tasks running`
    const parts = [c.tasks ? `${c.tasks} task${c.tasks === 1 ? '' : 's'}` : '', c.crons ? `${c.crons} scheduled` : ''].filter(Boolean)
    const detail = parts.length > 1 ? ` (${parts.join(', ')})` : c.tasks === 0 && c.crons === 1 ? ' (loop)' : ''
    const cmds = await read($, running)
    const cmdLabel = cmds === 1 ? '1 command running' : `${cmds} commands running`
    const wr = await read($, writing)
    const wrLabel = wr === 1 ? 'writing a command' : `writing ${wr} commands`
    const isHidden = await read($, hidden)
    const { Box, Button, Text } = $.ui.resolve(e)
    // short labels: a desktop draws a button's label, and every character it takes is room the first row needs
    // (never a parameter named h: JSX compiles every element to a call of h, and a second h would shadow it)
    const toggle = (
      <Button key="toggle" label={isHidden ? 'Show' : 'Hide'} onPress={() => update($, hidden, folded => !folded)}>
        <Text color="claude">{isHidden ? SHOW : HIDE}</Text>
      </Button>
    )

    // folded, only the button stays, where it stood
    if (isHidden) {
      return (
        <Box flexDirection="row" justifyContent="flex-end">
          {toggle}
        </Box>
      )
    }

    const qs = await read($, questions)
    const listed = await read($, showQuestions)
    const qLabel = qs.length === 1 ? '1 question waiting' : `${qs.length} questions waiting`
    // a desktop paints every button's text in its own white, whatever colour a plugin gives - so the count is plain
    // text (its number in the band's first column), white at zero and the calm yellow from one, with a short button
    const toggleList = () => update($, showQuestions, s => !s)
    const counter = [
      <Text key="qcount" color={qs.length > 0 ? GOLD : 'text'}>
        {qLabel}
      </Text>,
      <Button key="questions" label={listed ? 'Close' : 'List'} onPress={toggleList} />,
    ]

    const row = (
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row">
          <Text color={colorOf(c)}>{label}</Text>
          {detail ? <Text color="inactive">{detail}</Text> : null}
          <Text color="inactive">{' · '}</Text>
          <Text color={cmds > 0 ? 'success' : 'inactive'}>{cmdLabel}</Text>
          {wr > 0 ? <Text color="inactive">{' · '}</Text> : null}
          {wr > 0 ? <Text color={ROAST}>{wrLabel}</Text> : null}
        </Box>
        {toggle}
      </Box>
    )
    const questionsRow = (
      <Box key="questionsRow" flexDirection="row" columnGap={BUTTON_GAP}>
        {counter}
      </Box>
    )

    // the list under the counter: one line per question, cut to the band's width, each number in the first column;
    // never more lines than the band's own rows allow beside its two - the rest counted
    const width = Math.max(20, (e.props.bodyColumns ?? 80) - 4)
    const room = Math.max(1, (e.props.maxRows ?? 10) - 2)
    const shown = qs.length > room ? qs.slice(0, room - 1) : qs
    return (
      <Box flexDirection="column">
        {row}
        {questionsRow}
        {listed && qs.length === 0 ? <Text color="inactive">{'No question waits'}</Text> : null}
        {listed
          ? shown.map((q, i) => (
              <Text key={`q${i}`} color={AMBER}>
                {`${i + 1}. ${q.length > width ? q.slice(0, width - 1) + '…' : q}`}
              </Text>
            ))
          : null}
        {listed && qs.length > shown.length ? (
          <Text color="inactive">{`… and ${qs.length - shown.length} more in ${questionsPath ?? 'the questions file'}`}</Text>
        ) : null}
      </Box>
    )
  })
}
