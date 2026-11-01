import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnStepChunk, TurnStepResult } from 'claude-code'

import type { Counts, Watched } from '../types'

// GLANCE BAND - one band above the prompt that says, at a glance, what Claude Code is doing and whether a question of
// Claude's is waiting for you.
//
// Row 1: the session's background work and scheduled loops - "N background tasks running", blue while any run, grey at
// zero, lilac when the only thing running is a loop - then the shell commands running right now (green while any run)
// and, in brown, what Claude is still writing: "writing a command", "creating a file" ("rewriting a file" once its name
// turns out to be a file that already exists), "editing a file" ("making N edits" for several); Hide folds the band
// down to its Show button.
// Row 2: the background work of your OTHER sessions - "N Background tasks running: other sessions", pink from one, grey
// at zero - so a glance says whether another session is still busy.
// Row 3: Claude's questions still waiting for you, counted from ONE Markdown file that all your sessions share, one
// section per session: "N questions waiting: this session; M questions waiting: other sessions" - each count white at
// zero, a calm yellow from one - with a List button that unfolds THIS session's open questions under it.
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
const creatingFiles = atom({ plugin: 'glance-band', key: 'creatingFiles' } as const, 0)
const rewritingFiles = atom({ plugin: 'glance-band', key: 'rewritingFiles' } as const, 0)
const editingFiles = atom({ plugin: 'glance-band', key: 'editingFiles' } as const, 0)
const searching = atom({ plugin: 'glance-band', key: 'searching' } as const, 0)
const questions = atom({ plugin: 'glance-band', key: 'questions' } as const, [])
const otherQuestions = atom({ plugin: 'glance-band', key: 'otherQuestions' } as const, 0)
const showQuestions = atom({ plugin: 'glance-band', key: 'showQuestions' } as const, false)
const told = atom({ plugin: 'glance-band', key: 'told' } as const, { n: 0, at: 0 })
const otherTasks = atom({ plugin: 'glance-band', key: 'otherTasks' } as const, 0)

const COMMANDS = ['Bash', 'PowerShell']
// A SEARCH RUNNING - Grep or Glob, what Claude Code draws as "Searching <pattern>" - from its call until it returns, in
// the same brown as what is being written; a search over a large folder can run for minutes
const SEARCHES = ['Grep', 'Glob']
// WHAT IS BEING WRITTEN, from a call's first streamed piece until Claude Code runs it: a command, a whole file (a new
// one, or one that already exists - decided once the file's name streams in), or an edit; reading is left out (a read
// is a file name and runs in a blink). Each kind is counted on its own: Claude Code sometimes holds several calls of
// one reply until the last is written, and sometimes runs each as soon as it is written.
type Kind = 'command' | 'create' | 'rewrite' | 'edit'
const WRITTEN = new Map<string, Kind>([
  ['Bash', 'command'], ['PowerShell', 'command'], ['Write', 'create'], ['Edit', 'edit'], ['NotebookEdit', 'edit'],
])
const FILE_PATH = /"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/
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
const PINK = '#F48FB1'
const AMBER = 'warning'
const HIDE = '▼'
const SHOW = '▶'
// a mod spaces in character cells; a desktop's cell is its code font's advance, about 7 to 8 px - so about 3 px
const BUTTON_GAP = 0.4

// THE QUESTIONS FILE: every line "- [ ] ..." is a question waiting, every "- [x] ..." one answered. Its path is the
// `questions_file` option, or <home>/.claude/questions_waiting.md; unless the `teach_claude` option is off, a short
// section of the system prompt asks Claude to keep it (QUESTIONS_NOTE below).
// ONE FILE, ONE SECTION PER SESSION (1.2.0): every session that loads the band shares the file, so each session's
// questions stand between its own two lines, "## session <id>" and "<!-- end of session <id> -->". The id is the
// session's own id, its transcript file's name, which $.session.id() answers: it stays when the session is renamed,
// so a session's name is never the key. The band counts this session's open lines and every other open line apart and
// lists this session's alone; a line outside every section (one written before 1.2.0, say) is another session's.
const SECTION_HEAD = /^## session (\S+)\s*$/
const SECTION_END = /^<!-- end of session (\S+) -->\s*$/
const OPEN_LINE = /^- \[ \] (.+?)\s*$/
const sectionHead = (id: string) => `## session ${id}`
const sectionEnd = (id: string) => `<!-- end of session ${id} -->`
const DEFAULT_QUESTIONS = '/.claude/questions_waiting.md'

// THE OTHER SESSIONS' TASKS (1.3.0). A plugin cannot ask another session anything, so each band tells the others: it keeps
// ONE SMALL FILE OF ITS OWN in <home>/.claude/band_tasks, named by its session's id and holding its first row's number,
// the loops included, and every band adds up the files of the others. One file per session, because a file with one
// writer can never lose another session's count. $.fs deletes nothing, so a session that ends leaves its last number
// behind: while a count stands above zero its file is written again every BEAT_MS, and a file older than STALE_MS is a
// session that has gone and is not counted. Zero is said once, and a session that never ran a task writes nothing at all.
// The `other_sessions_tasks` option off: nothing is written or read there, and the row is not drawn.
const DEFAULT_TASKS = '/.claude/band_tasks'
const BEAT_MS = 10_000
const STALE_MS = 30_000

type Options = { questions_file?: string; teach_claude?: boolean; other_sessions_tasks?: boolean }

const colorOf = (c: Counts) => (c.tasks + c.crons === 0 ? 'inactive' : c.tasks === 0 && c.crons === 1 ? LILAC : 'suggestion')

// the note names the session's id and its section, so the rule holds after a compaction too: the system prompt is
// sent whole with every request
const QUESTIONS_NOTE = (path: string, id: string | null) =>
  [
    'The Glance Band plugin shows the user, above the prompt, how many of your questions wait for an answer, counted ' +
      'from one file that all of the user\'s sessions share: ' + path + '.',
    id === null
      ? 'Whenever you ask the user a question you need answered (a choice, a confirmation, a missing fact), add ONE ' +
        'line to that file in the same step: "- [ ] YYYY-MM-DD HH:MM · topic · the question" (create the file if it ' +
        'is missing).'
      : 'The file holds one section per session. THIS SESSION\'S ID IS ' + id + ' - its transcript file\'s name, ' +
        'which stays when the session is renamed (never use a session\'s name). This session\'s section is every line ' +
        'between "' + sectionHead(id) + '" and "' + sectionEnd(id) + '"; if the file has no such section yet, add ' +
        'those two lines at its end (create the file if it is missing). Whenever you ask the user a question you need ' +
        'answered (a choice, a confirmation, a missing fact), add ONE line inside this section, above its end line, in ' +
        'the same step: "- [ ] YYYY-MM-DD HH:MM · topic · the question".',
    'When the user answers it, or it stops mattering, change that line\'s "- [ ]" to "- [x]" and add the answer after it.',
    id === null
      ? ''
      : 'Ask the user only the questions in this session\'s section: a line in another session\'s section, or outside ' +
        'every section, belongs to another session - never ask it, tick it or edit it.',
    'Never keep a count of the questions anywhere else: the band counts the open lines itself.',
  ]
    .filter(Boolean)
    .join(' ')

const sessionId = async ($: EngineInterface): Promise<string | null> => {
  try {
    return String(await $.session.id()) || null
  } catch {
    return null
  }
}

// each line's owner: the session whose header stands above it until its end line (both lines its own); null outside
// every section
const owners = (lines: string[]): (string | null)[] => {
  let owner: string | null = null
  return lines.map(ln => {
    const head = SECTION_HEAD.exec(ln)
    if (head) {
      owner = head[1]
      return owner
    }
    const end = SECTION_END.exec(ln)
    if (end) {
      const was = owner
      owner = null
      return was
    }
    return owner
  })
}

// the module's own memory, reset at every load: what the shells' output files said last, whether the timer runs, and
// the questions file's path and the tasks folder once resolved
const seen = new Map<string, number>()
let ticking = false
let questionsPath: string | null = null
let tasksDir: string | null = null
const pending = new Map<string, Kind>()
// a whole-file write's arguments as they stream in, by the block's index, until the file's name can be read from them
const naming = new Map<number, { id: string; json: string }>()

const homeFolder = async ($: EngineInterface) => {
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? (await $.env.get('USERPROFILE').catch(() => undefined))
  return home ? home.replace(/[\\/]+$/, '') : ''
}

const resolvePath = async ($: EngineInterface, options: Options) => {
  if (questionsPath !== null) {
    return questionsPath
  }
  const chosen = (options.questions_file ?? '').trim()
  if (chosen) {
    questionsPath = chosen
  } else {
    const home = await homeFolder($)
    questionsPath = home ? home + DEFAULT_QUESTIONS : ''
  }
  return questionsPath
}

const resolveTasksDir = async ($: EngineInterface) => {
  if (tasksDir === null) {
    const home = await homeFolder($)
    tasksDir = home ? home + DEFAULT_TASKS : ''
  }
  return tasksDir
}

// read whole at every tick (a small file), the band redrawn only when this session's list or the other sessions'
// count changed
const readQuestions = async ($: EngineInterface, options: Options) => {
  const mine: string[] = []
  let others = 0
  try {
    const path = await resolvePath($, options)
    if (path) {
      const s = await $.fs.stat(path)
      if (s.size <= 1_000_000) {
        const me = await sessionId($)
        const lines = String(await $.fs.read(path)).split('\n')
        const own = owners(lines)
        lines.forEach((ln, i) => {
          const m = OPEN_LINE.exec(ln)
          if (!m) {
            return
          }
          if (me !== null && own[i] === me) {
            mine.push(m[1].trim())
          } else {
            others += 1
          }
        })
      }
    }
  } catch {
    // no file is no question waiting
  }
  const now = await read($, questions)
  if (now.length !== mine.length || now.some((q, i) => q !== mine[i])) {
    await update($, questions, () => mine)
  }
  if ((await read($, otherQuestions)) !== others) {
    await update($, otherQuestions, () => others)
  }
}

const setWriting = async ($: EngineInterface) => {
  const n = (k: Kind) => [...pending.values()].filter(v => v === k).length
  const [c, cr, rw, e] = [n('command'), n('create'), n('rewrite'), n('edit')]
  await update($, writing, () => c)
  await update($, creatingFiles, () => cr)
  await update($, rewritingFiles, () => rw)
  await update($, editingFiles, () => e)
}

// a whole-file write whose name has streamed in: a file that already exists is REWRITTEN, not created (the band asks
// only whether the path exists - it never reads the file)
const nameWrite = async ($: EngineInterface, id: string, json: string) => {
  const m = FILE_PATH.exec(json)
  if (!m) {
    return false
  }
  const path = JSON.parse(`"${m[1]}"`) as string
  if (pending.get(id) === 'create' && (await $.fs.exists(path).catch(() => false))) {
    pending.set(id, 'rewrite')
    await setWriting($)
  }
  return true
}

// passes the reply's stream through untouched, noting each command or file whose writing begins
async function* tap($: EngineInterface, stream: AsyncGenerator<TurnStepChunk, TurnStepResult>) {
  let step = await stream.next()
  while (!step.done) {
    const c = step.value
    const kind = c.kind === 'tool' ? WRITTEN.get(c.name) : undefined
    if (c.kind === 'tool') {
      naming.delete(c.index)  // a new call at this place: an earlier write's name hunt there is over
    }
    if (c.kind === 'tool' && kind) {
      pending.set(c.id, kind)
      if (kind === 'create') {
        naming.set(c.index, { id: c.id, json: '' })
      }
      await setWriting($).catch(() => undefined)
    } else if (c.kind === 'input' && naming.has(c.index)) {
      const w = naming.get(c.index) as { id: string; json: string }
      w.json += c.json
      if (await nameWrite($, w.id, w.json).catch(() => true)) {
        naming.delete(c.index)
      }
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

// this session's number, written only when it moved, or when it stands above zero and its file is due again
const tellTasks = async ($: EngineInterface, options: Options) => {
  if (options.other_sessions_tasks === false) {
    return
  }
  const folder = await resolveTasksDir($)
  const me = await sessionId($)
  if (!folder || me === null) {
    return
  }
  const c = await read($, counts)
  const n = c === null ? 0 : c.tasks + c.crons
  const now = await $.clock.now()
  const was = await read($, told)
  if (n !== was.n || (n > 0 && now - was.at >= BEAT_MS)) {
    await $.fs.write(`${folder}/${me}.txt`, `${n}\n`)
    await update($, told, () => ({ n, at: now }))
  }
}

// the others' numbers added up, read whole at every tick like the questions, and the band redrawn only when the sum
// changed; a file holding no number counts for nothing
const readOtherTasks = async ($: EngineInterface, options: Options) => {
  if (options.other_sessions_tasks === false) {
    return
  }
  let sum = 0
  try {
    const folder = await resolveTasksDir($)
    if (folder) {
      const mine = `${await sessionId($)}.txt`
      const now = await $.clock.now()
      for (const f of await $.fs.list(folder)) {
        if (f.kind === 'file' && f.name !== mine && now - f.mtimeMs < STALE_MS) {
          sum += Number.parseInt(String(await $.fs.read(`${folder}/${f.name}`)), 10) || 0
        }
      }
    }
  } catch {
    // no folder yet is no other session telling
  }
  if ((await read($, otherTasks)) !== sum) {
    await update($, otherTasks, () => sum)
  }
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
  await tellTasks($, options).catch(() => undefined)
  await readOtherTasks($, options)
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
    await readOtherTasks($, options)
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
    const note = QUESTIONS_NOTE(path, await sessionId($))
    return { sections: [...r.sections, { id: `${PLUGIN}:questions`, text: note, scope: 'session' as const }] }
  })

  on('classic.Stop', async ($, e, next) => {
    const live = (e.background_tasks ?? []).filter(t => !ENDED.includes(String(t.status).toLowerCase()))
    const crons = (e.session_crons ?? []).length
    const now: Counts = { tasks: live.length, crons }
    await update($, counts, () => now)
    await update($, running, () => 0)
    await update($, searching, () => 0)
    pending.clear()
    naming.clear()
    await setWriting($)
    await readQuestions($, options)
    await tellTasks($, options).catch(() => undefined)
    await readOtherTasks($, options)

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
    const isSearch = SEARCHES.includes(e.tool)
    // each counter is named where it is written: Claude Code's scan lists what a module reads and writes from the call
    if (isCommand) {
      await update($, running, n => n + 1).catch(() => undefined)
    } else if (isSearch) {
      await update($, searching, n => n + 1).catch(() => undefined)
    }
    const r = await next(e).finally(() =>
      isCommand
        ? update($, running, n => Math.max(0, n - 1)).catch(() => undefined)
        : isSearch
          ? update($, searching, n => Math.max(0, n - 1)).catch(() => undefined)
          : undefined,
    )
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
    const wc = await read($, creatingFiles)
    const wrw = await read($, rewritingFiles)
    const we = await read($, editingFiles)
    const sr = await read($, searching)
    // several edits waiting may be to one file or to several, so they are counted as edits; a search running stands
    // first among the brown labels, beside the commands running
    const writes = [
      sr === 0 ? '' : sr === 1 ? 'searching' : `running ${sr} searches`,
      wr === 0 ? '' : wr === 1 ? 'writing a command' : `writing ${wr} commands`,
      wc === 0 ? '' : wc === 1 ? 'creating a file' : `creating ${wc} files`,
      wrw === 0 ? '' : wrw === 1 ? 'rewriting a file' : `rewriting ${wrw} files`,
      we === 0 ? '' : we === 1 ? 'editing a file' : `making ${we} edits`,
    ].filter(Boolean)
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
    const others = await read($, otherQuestions)
    const listed = await read($, showQuestions)
    const waiting = (n: number) => (n === 1 ? '1 question waiting' : `${n} questions waiting`)
    // a desktop paints every button's text in its own white, whatever colour a plugin gives - so the counts are plain
    // text (the first number in the band's first column), each white at zero and the calm yellow from one, with a short
    // button; this session's count and the other sessions' apart, in one row of their own so the row's gap stands only
    // between the words and the button
    const toggleList = () => update($, showQuestions, s => !s)
    const counter = [
      <Box key="qcounts" flexDirection="row">
        <Text color={qs.length > 0 ? GOLD : 'text'}>{`${waiting(qs.length)}: this session`}</Text>
        <Text color="text">{'; '}</Text>
        <Text color={others > 0 ? GOLD : 'text'}>{`${waiting(others)}: other sessions`}</Text>
      </Box>,
      <Button key="questions" label={listed ? 'Close' : 'List'} onPress={toggleList} />,
    ]

    const row = (
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row">
          <Text color={colorOf(c)}>{label}</Text>
          {detail ? <Text color="inactive">{detail}</Text> : null}
          <Text color="inactive">{' · '}</Text>
          <Text color={cmds > 0 ? 'success' : 'inactive'}>{cmdLabel}</Text>
          {writes.flatMap(w => [
            <Text key={`dot-${w}`} color="inactive">{' · '}</Text>,
            <Text key={w} color={ROAST}>{w}</Text>,
          ])}
        </Box>
        {toggle}
      </Box>
    )
    const questionsRow = (
      <Box key="questionsRow" flexDirection="row" columnGap={BUTTON_GAP}>
        {counter}
      </Box>
    )
    // the other sessions' tasks, directly under the first row: pink from 1, grey at 0 like the first row's own count, so
    // the colour alone says whether any other session has work; with the option off the row is not drawn
    const peers = options.other_sessions_tasks === false ? null : await read($, otherTasks)

    // the list under the counter: one line per question, cut to the band's width, each number in the first column;
    // never more lines than the band's own rows allow beside the rows above it - the rest counted
    const width = Math.max(20, (e.props.bodyColumns ?? 80) - 4)
    const room = Math.max(1, (e.props.maxRows ?? 10) - (peers === null ? 2 : 3))
    const shown = qs.length > room ? qs.slice(0, room - 1) : qs
    return (
      <Box flexDirection="column">
        {row}
        {peers === null ? null : (
          <Text color={peers > 0 ? PINK : 'inactive'}>
            {`${peers} Background task${peers === 1 ? '' : 's'} running: other sessions`}
          </Text>
        )}
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
