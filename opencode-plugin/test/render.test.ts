import { describe, expect, it } from 'vitest'

import {
  EMPTY_RESULT_HINT,
  clip,
  normalizeSearchPayload,
  renderSearchResult,
} from '../src/render.js'

describe('clip', () => {
  it('leaves short text alone', () => {
    expect(clip('abc', 10)).toBe('abc')
  })

  it('marks text that was shortened', () => {
    expect(clip('abcdef', 3)).toBe('abc…')
  })
})

describe('normalizeSearchPayload', () => {
  it('orders facts by score', () => {
    const value = normalizeSearchPayload({
      facts: [
        { id: 'a', fact: 'low', score: 0.1 },
        { id: 'b', fact: 'high', score: 0.9 },
      ],
    })
    expect(value.facts.map(f => f.id)).toEqual(['b', 'a'])
  })

  it('drops facts with no text rather than rendering blanks', () => {
    const value = normalizeSearchPayload({ facts: [{ id: 'a', fact: '' }, { id: 'b', fact: 'kept' }] })
    expect(value.facts.map(f => f.id)).toEqual(['b'])
  })

  it('degrades to empty on a payload whose shape drifted', () => {
    expect(normalizeSearchPayload(null).facts).toEqual([])
    expect(normalizeSearchPayload({ facts: 'not an array' }).facts).toEqual([])
    expect(normalizeSearchPayload({ facts: [42, null] }).facts).toEqual([])
  })

  it('reads either document name field', () => {
    const value = normalizeSearchPayload({
      documents: [{ document_id: 'd1', file_name: 'notes.md' }],
    })
    expect(value.documents?.[0]?.name).toBe('notes.md')
  })
})

describe('renderSearchResult', () => {
  it('never shows a relevance score', () => {
    const text = renderSearchResult({
      facts: [{ id: 'f1', fact: 'the user prefers tabs', score: 0.87 }],
    })
    expect(text).not.toMatch(/0\.87|87%|score/i)
    expect(text).toContain('the user prefers tabs')
  })

  it('gives an empty result a hint instead of nothing', () => {
    expect(renderSearchResult({ facts: [] })).toBe(EMPTY_RESULT_HINT)
  })

  it('tells the model to judge each hit, including across projects', () => {
    const text = renderSearchResult({ facts: [{ id: 'f1', fact: 'a ranked hit' }] })
    expect(text).toContain('Judge each fact')
    expect(text).toContain('another project')
  })

  it('puts facts before files', () => {
    const text = renderSearchResult({
      facts: [{ id: 'f1', fact: 'a fact' }],
      documents: [{ id: 'd1', name: 'doc.md' }],
    })
    expect(text.indexOf('FACTS')).toBeLessThan(text.indexOf('FILES'))
  })

  it('keeps at most three spans per document', () => {
    const text = renderSearchResult({
      facts: [],
      documents: [{ id: 'd1', name: 'doc.md', spans: ['s1', 's2', 's3', 's4'] }],
    })
    expect(text).toContain('"s3"')
    expect(text).not.toContain('"s4"')
  })

  it('leads with a notice when one is supplied', () => {
    const text = renderSearchResult({ facts: [], notice: 'degraded' })
    expect(text.startsWith('degraded')).toBe(true)
  })
})
