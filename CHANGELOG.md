# Changes

## 1.3.0

- **Your other sessions' background tasks.** A new row directly under the first: "N Background tasks running: other
  sessions", pink from one, grey at zero - so a glance tells you whether another session is still busy.
- **The band now writes a small file of its own.** A plugin cannot ask another session anything, so each session's band
  keeps one tiny file in `<home>/.claude/band_tasks`, named by the session's id and holding only that session's number of
  tasks. The numbers never leave your computer. A file not refreshed for 30 seconds counts as a session that has ended.
- A new setting, `other_sessions_tasks` (on by default): turned off, the row is not drawn and nothing is written or read
  there. The README's data section says all of this.

## 1.2.0

- **Questions per session.** All your sessions share one questions file, so a question Claude asked you in one
  session used to be counted - and listed - in every other. Now each session's questions stand in a section of their
  own, between `## session <id>` and `<!-- end of session <id> -->`, and the band reads "N questions waiting: this
  session; M questions waiting: other sessions": the List shows this session's questions only.
- The id is the session's own id, its transcript file's name: it stays when you rename the session.
- With `teach_claude` on, the note to Claude names the session's id and its section, and asks Claude to ask you only
  the questions of its own section; the note is sent with every request, so it holds after a compaction too (about
  300 tokens per request, up from about 120).
- Lines written before 1.2.0 stand outside every section and count under "other sessions"; move one into a session's
  section to list it there. The README's data section names the session's id among what the band reads and what the
  note sends.

## 1.1.1

- **A search running is shown.** While a search Claude started runs (Grep or Glob - what Claude Code draws as
  "Searching ..."), the band shows "searching" in the same brown, beside the commands running; "running N searches"
  when several run at once. Before, a search of several minutes left the band reading "0 commands running".
- Nothing new is read or stored: the band only counts the search calls by their tool's name.

## 1.1.0

- **What Claude is writing, for files too.** Beside "writing a command", the band now shows "creating a file" (a whole
  new file), "rewriting a file" (a whole file that replaces one already on disk) and "editing a file" ("making N edits"
  when several wait together), in the same brown, each counted on its own and all on one line.
- To tell creating from rewriting, the band asks your disk whether the file's path already exists - a yes or no; the
  file is never opened. The README's data section says so.
- Reading a file is deliberately not shown: it is over in a blink.

## 1.0.2

- A table in the README of every hook the band registers and what it does or changes.
- An internal rename, so the band's code passes the directory's checks.

## 1.0.1

- The README says plainly what happens to your data: what the band reads, holds, causes to be stored, and what leaves
  your computer.

## 1.0.0

- The first release: background tasks and loops, commands running, a command being written, and the questions counter
  with its list.
