import { describe, expect, test } from 'bun:test'
import fixtures from '../../../fixtures/notes.json'
import { findPatterns, mergeSpans, spansFromEntities } from './detect'
import { findLeaks, redact, restore } from './vault'

const NOTE = 'Patient: Maria Delgado, DOB 03/14/1972, cell 559-204-8817. Maria lives with Tomas Delgado in Fresno, CA 93721.'

describe('patterns', () => {
  test('find structured identifiers and tag a birth date', () => {
    const kinds = Object.fromEntries(findPatterns(NOTE).map((s) => [s.text, s.kind]))
    expect(kinds['03/14/1972']).toBe('dob')
    expect(kinds['559-204-8817']).toBe('phone')
    expect(kinds.Fresno).toBe('address')
    expect(kinds['93721']).toBe('address')
  })
})

describe('vault', () => {
  const spans = mergeSpans([
    ...findPatterns(NOTE),
    ...spansFromEntities(NOTE, [
      { text: 'Maria Delgado', kind: 'patient' },
      { text: 'Tomas Delgado', kind: 'relative' },
    ]),
  ])
  const today = new Date(2026, 10, 26)
  const { redacted, entries } = redact(NOTE, spans, today)

  test('redacted text holds no held value, and keeps an age instead of the birth date', () => {
    expect(findLeaks(redacted, spans.map((s) => s.text))).toEqual([])
    expect(redacted).toContain('[DOB_1] (age 54)')
  })

  test('a lone first name shares the token of the held full name it belongs to', () => {
    const maria = entries.find((e) => e.value === 'Maria Delgado')
    expect(redacted).toContain(`${maria?.token} lives`)
  })

  test('restore swaps tokens back and reports tokens it never issued', () => {
    const r = restore(`${redacted} See [PATIENT_9].`, entries)
    expect(r.text).toContain('Maria Delgado, DOB 03/14/1972')
    expect(r.unknown).toEqual(['[PATIENT_9]'])
  })
})

describe('leak scan', () => {
  test('matches whole words only, case-insensitively, inside JSON strings', () => {
    expect(findLeaks('{"text":"James played games"}', ['Ames'])).toEqual([])
    expect(findLeaks('{"text":"lives in ames"}', ['Ames'])).toEqual(['ames'])
    expect(findLeaks('{"text":"St. Brigid Children\\u0027s Hospital"}', ["St. Brigid Children's Hospital"])).toHaveLength(1)
  })
})

describe('fixtures', () => {
  test('every labeled identifier appears in its note', () => {
    for (const n of fixtures.notes) for (const i of n.identifiers) expect(n.text).toContain(i.text)
  })
})
