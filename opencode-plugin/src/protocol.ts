/**
 * The stable half of what this plugin injects: the memory protocol and the
 * backend status, appended to the system prompt.
 *
 * Why this text lives in the system prompt rather than in a message part:
 * opencode assembles the system prompt as `[header, everything-plugins-pushed]`
 * (`packages/opencode/src/session/llm/request.ts` collapses all plugin entries
 * into one second block, kept separate from the stable header — a shape that
 * exists to keep the header cacheable). Two consequences shape this module:
 *
 *   - content here must be STABLE within a session, or the second block is
 *     invalidated on every request. Hence: the protocol is fixed text, and the
 *     only variable — connectivity — is resolved once per session and cached.
 *   - content here is never compacted away, unlike anything in the message
 *     history. The protocol therefore survives long sessions, which is exactly
 *     what a "remember to search" instruction needs.
 *
 * Anything that legitimately changes per turn belongs in a message part, not
 * here.
 */

/** What the connectivity probe concluded, once, for this session. */
export type BackendStatus
  = | { state: 'connected', projects: number }
    | { state: 'cli-missing' }
    | { state: 'not-logged-in' }
    | { state: 'unreachable' }

const PROTOCOL_READ = `## Memory Lake

Memory Lake is the user's long-term memory **across projects, machines, and
clients**. opencode has no memory of its own, and it cannot see memories
written by other tools — including Claude Code, whose memories live in a
directory opencode never reads. Anything the user told you before this session,
or told a different assistant, is here or nowhere.

### When to search

- the user refers to something they told you before
- a question about the user, their preferences, or past decisions
- a project, document, or fact you have no record of in this session
- you are about to say "you never mentioned that", or to guess at a preference

Searching costs one tool call. Guessing at something the user already told you
costs their trust, so prefer the tool call.

### How to phrase a query

- **statement-style keywords beat questions**: \`user's preferred editor\`
  finds more than \`what editor do you like?\`
- **resolve pronouns to names**: \`Alice's review deadline\`, not \`her deadline\`
- **make relative dates absolute**: \`2026-07 migration\`, not \`last month's\`
- **one intent per query** — two ideas in one query match neither well
- for a vague question, run 2-3 differently-phrased searches rather than one
  long one

### How to read results

Results come back most-relevant-first, but the engine returns matches even for
a query with no good answer, so **judge every hit by reading it**.

In particular, **memories carry no scope**. A memory written while working in
another repository, for another organization, or on another machine may be
recorded in absolute terms and still not apply here. Check what a memory is
actually about before acting on it, and prefer what the user says in this
session over anything stored.

Never present a stored memory to the user as though they said it just now, and
do not mention retrieved memories at all unless they bear on the answer.`

/**
 * The write half, omitted when no actor is configured.
 *
 * It exists because the read half had a whole section on when to search and
 * this side had one clause, which is backwards: the model recalls when it
 * notices a gap, but nothing makes it notice the moment a durable fact goes
 * past. This says what those moments look like.
 *
 * Deliberately about WHEN, not HOW — how to word a fact belongs in the
 * `memory_remember` description, where it is read at the moment of use.
 */
const PROTOCOL_WRITE = `### When to remember

Store a fact the moment the user establishes something that outlives the
current task. The strongest signals:

- **a standing instruction**: "from now on…", "always…", "never…", "don't do
  that again", "next time…"
- **a correction**: they tell you an approach, assumption, or habit of yours
  was wrong. The correction is the memory, along with why
- **a decision and its reasoning**: what was chosen, what was rejected, and
  what made the difference
- **something about them**: their name, role, tools, conventions, how they
  want to be worked with

Do NOT store: file or code contents, the state of the current task, anything
re-derivable from the repository, or something true only for the next few
minutes. If you would not want to read it back in six months, do not write it.

**Say the scope inside the fact.** Stored memories carry no scope of their
own, so a fact recorded in absolute terms will later be applied everywhere. If
something holds only for one repository, one organization, or one machine,
name it in the fact text — "in the acme/api repo, …" — otherwise you are
writing a rule for every future session in every project.

Store it as it happens rather than at the end: a session can be compacted or
closed at any point, and an unwritten fact is a fact the user has to repeat.
Do not ask permission for a clear standing instruction — the tool call is
already visible — and do not announce each write in prose.`

/**
 * Render the status sentence.
 *
 * The failure wording is the point of this whole function: an unreachable
 * backend that says nothing is indistinguishable, to the model, from a user
 * who never mentioned the thing. That confusion produces confident false
 * denials, which is the worst failure a memory system has.
 * @param status - the resolved connectivity state.
 * @returns one paragraph describing what memory is and is not available.
 */
export function renderStatus(status: BackendStatus): string {
  switch (status.state) {
    case 'connected':
      return `### Status\n\nMemory Lake is connected (${String(status.projects)} project(s)). `
        + 'Use the `memory_search` tool to recall, and `memory_remember` to store a '
        + 'durable fact the user would expect you to know next time.'
    case 'cli-missing':
      return '### Status\n\nMemory Lake is configured but the `memorylake` CLI is not '
        + 'installed, so recall is UNAVAILABLE this session. Do not treat the absence '
        + 'of memories as evidence that the user never told you something — say the '
        + 'memory backend could not be reached.'
    case 'not-logged-in':
      return '### Status\n\nMemory Lake is configured but not authenticated, so recall '
        + 'is UNAVAILABLE this session. Tell the user to run `memorylake auth login`. '
        + 'Do not treat missing memories as "you never told me that".'
    case 'unreachable':
      return '### Status\n\nMemory Lake is configured but unreachable, so recall is '
        + 'UNAVAILABLE this session. If you cannot find something, say the memory '
        + 'backend could not be reached — do not conclude the memory does not exist.'
  }
}

/**
 * Build the complete system block.
 *
 * Pure and deterministic: given the same status it returns byte-identical
 * text, which is what keeps opencode's second system block cacheable across
 * the requests of one session.
 * @param status - the resolved connectivity state for this session.
 * @param canWrite - whether an actor is configured, so writes are possible.
 * @returns the text to append to `output.system`.
 */
export function buildSystemBlock(status: BackendStatus, canWrite: boolean): string {
  const sections = [PROTOCOL_READ]
  // Only describe writing when writing is possible. Teaching the model when to
  // reach for a tool it has not been given is a recipe for it inventing one.
  if (canWrite) sections.push(PROTOCOL_WRITE)
  sections.push(renderStatus(status))
  if (!canWrite) {
    sections.push(
      'No actor is configured, so storing new memories is unavailable this '
      + 'session and the `memory_remember` tool is not offered. Recall still '
      + 'works. If the user asks you to remember something, say it cannot be '
      + 'stored right now and point them at `/memorylake:init` in Claude Code '
      + 'or the setup skill in any harness — do not claim to have saved it.',
    )
  }
  return sections.join('\n\n')
}

/**
 * The block shown when the plugin is installed but not configured.
 *
 * Deliberately tiny — two sentences and a tool name. The full setup wizard
 * sits behind `memory_setup` so an unconfigured session pays almost nothing
 * for discoverability, and only a user who actually asks pulls in the text.
 */
export const SETUP_BLOCK
  = '## Memory Lake\n\n'
    + 'The Memory Lake plugin is installed but not configured, so this session has '
    + 'no long-term memory: nothing the user told you in earlier sessions, other '
    + 'projects, or other tools is available. Do not claim to remember anything '
    + 'across sessions, and do not offer to remember things for later.\n\n'
    + 'If the user asks to set up, connect, or fix memory — or wonders why you do '
    + 'not remember them — call the `memory_setup` tool for the steps. Do not '
    + 'raise it unprompted.'

/**
 * The line appended to opencode's compaction prompt.
 *
 * Deliberately one sentence appended to `output.context`, never a replacement
 * of `output.prompt`: replacing the host's compaction prompt wholesale is far
 * beyond what a memory plugin should do to a session it does not own.
 */
export const COMPACTION_CONTEXT
  = 'Preserve any durable facts established in this session — the user\'s '
    + 'stated preferences, decisions made and their reasons, and corrections '
    + 'the user issued. These outlive the current task, and losing them to '
    + 'compaction means the user has to repeat themselves.'
