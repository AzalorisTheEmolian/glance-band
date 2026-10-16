# Changes

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
