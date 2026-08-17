import { describe, expect, it } from 'vitest'
import { clip, EMPTY_RESULT_HINT, renderSearchResult } from '../src/recall-render.js'

describe('renderSearchResult', () => {
  it('rule 4: an empty result carries the retry-then-be-honest hint, never a bare empty list', () => {
    const text = renderSearchResult({ facts: [] })
    expect(text).toBe(EMPTY_RESULT_HINT)
    expect(text).toContain('do not invent an answer')
  })

  it('a notice replaces the hint and renders first', () => {
    const text = renderSearchResult({ facts: [], notice: 'backend unreachable' })
    expect(text).toBe('backend unreachable')
  })

  it('renders facts with ids and the judgment reminder', () => {
    const text = renderSearchResult({
      facts: [
        { id: 'f-1', fact: 'user prefers vim' },
        { id: 'f-2', fact: 'user works at Acme' },
      ],
    })
    expect(text).toContain('FACTS (2, most relevant first)')
    expect(text).toContain('user prefers vim  [f-1]')
    expect(text).toContain('Judge each fact against the question by its content')
  })

  it('clips a fact at 300 characters with an ellipsis, and only past the boundary', () => {
    const exactly300 = 'a'.repeat(300)
    const over = 'b'.repeat(301)
    const text = renderSearchResult({
      facts: [
        { id: 'f-1', fact: exactly300 },
        { id: 'f-2', fact: over },
      ],
    })
    expect(text).toContain(`${exactly300}  [f-1]`)
    expect(text).not.toContain(`${exactly300}…`)
    expect(text).toContain(`${'b'.repeat(300)}…  [f-2]`)
    expect(text).not.toContain(over)
  })

  it('rule 1: facts render before documents', () => {
    const text = renderSearchResult({
      facts: [{ id: 'f-1', fact: 'a fact' }],
      documents: [{ id: 'd-1', name: 'notes.md' }],
    })
    expect(text.indexOf('FACTS')).toBeLessThan(text.indexOf('FILES'))
  })

  it('rule 2: document summaries clip to 120 characters', () => {
    const summary = 's'.repeat(200)
    const text = renderSearchResult({
      facts: [],
      documents: [{ id: 'd-1', name: 'notes.md', summary }],
    })
    expect(text).toContain(`${'s'.repeat(120)}…`)
    expect(text).not.toContain('s'.repeat(121))
  })

  it('rule 3: at most 3 spans per document, each clipped to 400 characters', () => {
    const spans = ['one', 'two', 'three', 'four', 'x'.repeat(500)]
    const text = renderSearchResult({
      facts: [],
      documents: [{ id: 'd-1', name: 'big.md', spans }],
    })
    expect(text).toContain('"one"')
    expect(text).toContain('"three"')
    expect(text).not.toContain('"four"')
    expect(text).not.toContain('x'.repeat(401))

    const clipped = renderSearchResult({
      facts: [],
      documents: [{ id: 'd-2', name: 'long.md', spans: ['y'.repeat(500)] }],
    })
    expect(clipped).toContain(`${'y'.repeat(400)}…`)
  })

  it('rule 5: the canonical value carries no score, so none can render', () => {
    // The type system enforces this (SearchFact has no score member); the
    // runtime check guards against a score smuggled through extra keys.
    const fact = { id: 'f-1', fact: 'a ranked hit', score: 0.987 } as never
    const text = renderSearchResult({ facts: [fact] })
    expect(text).not.toContain('0.987')
    expect(text).not.toMatch(/score/i)
  })
})

describe('clip', () => {
  it('returns short strings verbatim and appends an ellipsis past the max', () => {
    expect(clip('short', 10)).toBe('short')
    expect(clip('exactlyten', 10)).toBe('exactlyten')
    expect(clip('elevenchars', 10)).toBe('elevenchar…')
  })
})
