/** What the band shows: the session's in-flight background tasks and its scheduled loops. */
export type Counts = { tasks: number; crons: number }

/** A shell task running in the background, and the output file whose last line says when it ended. */
export type Watched = { id: string; out: string }

declare module 'claude-code' {
  interface PluginState {
    'glance-band': {
      counts: Counts | null
      watch: Watched[]
      dir: string | null
      /** the shell commands running right now, each counted from its call to its return */
      running: number
      /** the band folded to its button by the person */
      hidden: boolean
      /** shell commands Claude is writing right now: from the call's first streamed piece until the call runs */
      writing: number
      /** the questions waiting: the open "- [ ]" lines of the questions file, read, never typed */
      questions: string[]
      /** the waiting questions unfolded under the band by the person */
      showQuestions: boolean
    }
  }
}
