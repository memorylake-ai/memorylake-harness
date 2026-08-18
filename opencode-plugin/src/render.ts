/**
 * Rendering search results for the model.
 *
 * Every rule below was added after an observed failure in an earlier
 * integration, and each one is a cross-harness contract — the Claude Code,
 * Codex, and dsh plugins render the same way, so a user who moves between
 * harnesses reads the same shape of answer.
 *
 *   1. Facts first. They are short, directly consumable, and the most likely
 *      answer to a question about the user. Models read sequentially.
 *   2. Document summaries clipped: one long irrelevant summary otherwise
 *      dominates the model's attention.
 *   3. Matched spans clipped, at most three per document: one document once
 *      returned five near-1000-character segments and buried everything else.
 *   4. An empty result carries a hint, never a bare empty list — a bare empty
 *      result invites the model to improvise an answer.
 *   5. Relevance scores order the list and are NEVER shown. They are weakly
 *      calibrated (a measured unrelated hit outscored a genuine one) and a
 *      model shown a number treats it as authority. Hard filtering by score is
 *      equally off the table: a threshold kills real hits. The model judges
 *      each hit by reading it, which is the only reliable signal available.
 */

/** One fact as returned by the CLI. */
export interface SearchFact {
  id: string
  fact: string
  score?: number
}

/** One document hit as returned by the CLI. */
export interface SearchDocument {
  id: string
  name: string
  summary?: string
  spans?: string[]
}

/** Everything the renderer needs, already normalized. */
export interface SearchRendering {
  facts: SearchFact[]
  documents?: SearchDocument[]
  /** A leading sentence, used to state a degraded state before the results. */
  notice?: string
}

/** Rule 4: what the model should do with a genuinely empty result. */
export const EMPTY_RESULT_HINT
  = 'No memories matched. Retry ONCE with different wording — entity names, '
    + 'synonyms, statement-style keywords. If still nothing, tell the user '
    + 'honestly; do not invent an answer.'

const FACT_CLIP = 300
const SUMMARY_CLIP = 120
const SPAN_CLIP = 400
const SPANS_PER_DOCUMENT = 3

/**
 * Clip a string, marking that it was clipped.
 * @param text - the text to clip.
 * @param max - the maximum number of characters to keep.
 * @returns the text, with an ellipsis appended when it was shortened.
 */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Read a string field from an unknown record, defaulting to empty. */
function str(source: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

/**
 * Normalize the CLI's JSON payload into the renderer's shape.
 *
 * Tolerant by design: a payload whose shape drifted should degrade to fewer
 * results, never to an exception inside a hook.
 * @param payload - the parsed JSON from `memorylake search`.
 * @returns the normalized rendering input.
 */
export function normalizeSearchPayload(payload: unknown): SearchRendering {
  const root = (payload ?? {}) as Record<string, unknown>
  const rawFacts = Array.isArray(root.facts) ? root.facts : []
  const rawDocuments = Array.isArray(root.documents) ? root.documents : []

  const facts: SearchFact[] = rawFacts
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map(item => ({
      id: str(item, 'id') || '?',
      fact: str(item, 'fact'),
      score: typeof item.score === 'number' ? item.score : undefined,
    }))
    .filter(fact => fact.fact.length > 0)
    // Rule 5: score decides order here and is dropped before rendering.
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))

  const documents: SearchDocument[] = rawDocuments
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => {
      const items = Array.isArray(item.items) ? item.items : []
      const spans = items
        .filter((span): span is Record<string, unknown> => typeof span === 'object' && span !== null)
        .map(span => str(span, 'text'))
        .filter(text => text.length > 0)
      return {
        id: str(item, 'document_id') || '?',
        name: str(item, 'document_name', 'file_name') || '?',
        summary: str(item, 'document_summary') || undefined,
        spans,
      }
    })

  return { facts, documents }
}

/**
 * Render a search result as the text the model reads.
 * @param value - the normalized results, optionally prefixed by a notice.
 * @returns the complete model-facing text.
 */
export function renderSearchResult(value: SearchRendering): string {
  const parts: string[] = []
  if (value.notice !== undefined && value.notice.length > 0) parts.push(value.notice)

  const facts = value.facts
  const documents = value.documents ?? []

  if (facts.length === 0 && documents.length === 0) {
    if (parts.length === 0) parts.push(EMPTY_RESULT_HINT)
    return parts.join('\n\n')
  }

  if (facts.length > 0) {
    const lines = facts.map(fact => `  - ${clip(fact.fact, FACT_CLIP)}  [${fact.id}]`)
    parts.push(
      `FACTS (${facts.length}, most relevant first)\n${lines.join('\n')}\n\n`
      + '  Judge each fact against the question by its content — the list may '
      + 'include unrelated matches, and a memory written in another project may '
      + 'not apply here.',
    )
  }

  if (documents.length > 0) {
    const lines = documents.map((document) => {
      const summary = document.summary !== undefined && document.summary.length > 0
        ? ` — ${clip(document.summary, SUMMARY_CLIP)}`
        : ''
      const spans = (document.spans ?? [])
        .filter(span => span.length > 0)
        .slice(0, SPANS_PER_DOCUMENT)
        .map(span => `\n      "${clip(span, SPAN_CLIP)}"`)
        .join('')
      return `  ${document.name}${summary}  [${document.id}]${spans}`
    })
    parts.push(`FILES (${documents.length})\n${lines.join('\n')}`)
  }

  return parts.join('\n\n')
}
