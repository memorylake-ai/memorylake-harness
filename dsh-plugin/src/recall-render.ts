/**
 * Model-facing rendering of search results — a pure-function TypeScript port
 * of the Claude Code plugin's `ml-recall` trimming rules. Each rule was
 * added after an observed failure in an earlier integration; none may be
 * dropped:
 *
 * 1. Facts render first: short, directly consumable, and the most likely
 *    answer to a personal/preference question. Models read sequentially.
 * 2. File summaries clip to 120 chars: a full summary lets one irrelevant
 *    hit dominate attention. (v2 — documents are not searched in v1, but the
 *    renderer keeps the structure so v2 changes data, not rules.)
 * 3. Matched spans clip to 400 chars, at most 3 per document: one document
 *    once yielded five near-1000-char segments and buried the rest. (v2)
 * 4. Empty results carry a hint, never a bare empty list: a bare empty
 *    result invites the model to improvise an answer.
 * 5. Relevance scores are for ORDERING ONLY and never rendered: they are
 *    weakly calibrated (a measured unrelated hit outscored a genuine one),
 *    and a model shown the number treats it as authority. Hard threshold
 *    filtering is equally off the table — a threshold kills real hits. The
 *    canonical value type carries no score at all, so the rule holds by
 *    construction; sorting happens upstream where scores still exist.
 * @module
 */

/** One fact in the canonical `memory_search` value (no score, by rule 5). */
export interface SearchFact {
  id: string
  fact: string
  created_at?: string
}

/** One document hit — v2 structure, kept so rules 2 and 3 stay exercised. */
export interface SearchDocument {
  id: string
  name: string
  summary?: string
  spans?: string[]
}

/** The canonical `memory_search` value plus the v2 document extension. */
export interface SearchRendering {
  facts: SearchFact[]
  documents?: SearchDocument[]
  notice?: string
}

/** Rule 4's hint: what the model should do with a genuinely empty result. */
export const EMPTY_RESULT_HINT
  = 'No memories matched. Retry ONCE with different wording — entity names, '
    + 'synonyms, statement-style keywords. If still nothing, tell the user '
    + 'honestly; do not invent an answer.'

const FACT_CLIP = 300
const SUMMARY_CLIP = 120
const SPAN_CLIP = 400
const SPANS_PER_DOCUMENT = 3

/** Clip a string to `max` characters, appending an ellipsis when clipped. */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * Render a search value for the model. Facts first (rule 1), documents
 * clipped (rules 2–3), an explicit hint instead of emptiness (rule 4), and
 * no scores anywhere (rule 5).
 * @param value - the canonical value, optionally extended with documents.
 * @returns the complete model-facing text.
 */
export function renderSearchResult(value: SearchRendering): string {
  const parts: string[] = []
  if (value.notice !== undefined && value.notice.length > 0) {
    parts.push(value.notice)
  }
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
      + '  Judge each fact against the question by its content — the list may include unrelated matches.',
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
