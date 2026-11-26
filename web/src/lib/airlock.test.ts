import { describe, expect, test } from 'bun:test'
import fixtures from '../../../fixtures/notes.json'
import { expandSpans, findPatterns, mergeSpans, spansFromEntities } from './detect'
import { findLeaks, redact, restore, sealText } from './vault'

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
  ], NOTE)
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

describe('review findings', () => {
  test('overlapping detections become one held span, so no detector can shrink another', () => {
    const text = 'Dr. Jonathan Michaels\nAlice McDonald-SMITH called.'
    const spans = mergeSpans(
      [...findPatterns(text), ...spansFromEntities(text, [{ text: 'Alice McDonald-SMITH', kind: 'person' }])],
      text,
    )
    const { redacted } = redact(text, spans)
    expect(findLeaks(redacted, ['Jonathan Michaels', 'Alice McDonald-SMITH', 'McDonald-SMITH'])).toEqual([])
  })

  test('a held name typed into the task line is sealed before it can be sent', () => {
    const spans = mergeSpans(spansFromEntities(NOTE, [{ text: 'Maria Delgado', kind: 'patient' }]), NOTE)
    const { lookup } = redact(NOTE, spans)
    expect(sealText('Refer MARIA DELGADO; Maria Delgado agrees', lookup)).toBe('Refer [PATIENT_1]; [PATIENT_1] agrees')
  })

  test('a name part of a different role keeps its own token', () => {
    const text = 'Alice Jones attended with her sister Alice.'
    const spans = mergeSpans(
      [...findPatterns(text), ...spansFromEntities(text, [{ text: 'Alice Jones', kind: 'patient' }])],
      text,
    )
    const { redacted } = redact(text, spans)
    expect(redacted).toBe('[PATIENT_1] attended with her sister [RELATIVE_1].')
  })

  test('patterns catch bare ten-digit phones and day-month-year dates', () => {
    const found = findPatterns('Cell: 4155550123. DOB 14 March 1972.').map((s) => [s.text, s.kind])
    expect(found).toContainEqual(['4155550123', 'phone'])
    expect(found).toContainEqual(['14 March 1972', 'dob'])
  })
})

describe('case and line wraps', () => {
  test('a held name is held in capitals and across a line break', () => {
    const text = 'Pt Maria Delgado. Spoke with MARIA by phone. Seen with Maria\nDelgado.'
    const spans = mergeSpans(spansFromEntities(text, [{ text: 'Maria Delgado', kind: 'patient' }]), text)
    const { redacted } = redact(text, spans)
    expect(redacted).toBe('Pt [PATIENT_1]. Spoke with [PATIENT_1] by phone. Seen with [PATIENT_1].')
  })

  test('a clinician with a credential is not read as a city', () => {
    expect(findPatterns('Alan Whitcomb, MD').filter((s) => s.kind === 'address')).toEqual([])
  })
})

describe('second review', () => {
  const hold = (text: string, entities: { text: string; kind: string }[]) =>
    redact(text, mergeSpans(expandSpans(text, [...findPatterns(text), ...spansFromEntities(text, entities)]), text))

  test('lowercase and mixed-case mentions are held too', () => {
    const { redacted } = hold('Patient: Maria Delgado. maria reports pain. Seen at DaVita Riverbend (DAVITA RIVERBEND).', [
      { text: 'Maria Delgado', kind: 'patient' },
      { text: 'DaVita Riverbend', kind: 'organization' },
    ])
    expect(redacted).toBe('Patient: [PATIENT_1]. [PATIENT_1] reports pain. Seen at [ORG_1] ([ORG_1]).')
  })

  test('two-letter names and each half of a hyphenated surname are held', () => {
    const { redacted } = hold('Bo Chen saw Dr. Patel-Ramos. Bo agreed; Ramos will call.', [
      { text: 'Bo Chen', kind: 'patient' },
      { text: 'Patel-Ramos', kind: 'clinician' },
    ])
    expect(redacted).not.toMatch(/\bBo\b|Ramos/)
  })

  test('a value patterns found once is held everywhere it appears', () => {
    const { redacted } = hold('Lives with her husband Tomas. Safety plan reviewed with Tomas.', [])
    expect(redacted).toBe('Lives with her husband [RELATIVE_1]. Safety plan reviewed with [RELATIVE_1].')
  })

  test('a held word never matches inside a token', () => {
    const { redacted, lookup } = hold('Visit 11/24/2026. Patient: Kenji Date.', [{ text: 'Kenji Date', kind: 'patient' }])
    expect(sealText('Follow up on 11/24/2026 with Date', lookup)).toBe('Follow up on [DATE_1] with [PATIENT_1]')
    expect(findLeaks(redacted, ['Date', 'Kenji Date'])).toEqual([])
  })
})

describe('third review', () => {
  const hold = (text: string, entities: { text: string; kind: string }[]) =>
    redact(text, mergeSpans(expandSpans(text, [...findPatterns(text), ...spansFromEntities(text, entities)]), text))

  test('a short surname never swallows an abbreviation', () => {
    const { redacted } = hold('Patient Alex Ng. Continue NG tube feeds overnight. Ng agrees.', [{ text: 'Alex Ng', kind: 'patient' }])
    expect(redacted).toBe('Patient [PATIENT_1]. Continue NG tube feeds overnight. [PATIENT_1] agrees.')
  })

  test('sealing the task keeps word names case-sensitive', () => {
    const { lookup } = hold('Will Carter was seen today.', [{ text: 'Will Carter', kind: 'patient' }])
    expect(sealText('The clinic will call Will', lookup)).toBe('The clinic will call [PATIENT_1]')
  })

  test('a distinctive word of a held place is sealed in the task', () => {
    const { lookup } = hold('Admitted to Riverbend Medical Center.', [{ text: 'Riverbend Medical Center', kind: 'organization' }])
    expect(sealText('Refer back to riverbend', lookup)).toBe('Refer back to [ORG_1]')
  })
})

describe('leak scan', () => {
  test('matches whole words as written, in capitals or title case, inside JSON strings', () => {
    expect(findLeaks('{"text":"James played games"}', ['Ames'])).toEqual([])
    expect(findLeaks('{"text":"lives in AMES"}', ['Ames'])).toEqual(['ames'])
    expect(findLeaks('{"text":"you will never see"}', ['Will'])).toEqual([])
    expect(findLeaks('{"text":"Seen with Maria\\nDelgado"}', ['Maria Delgado'])).toEqual(['maria delgado'])
    expect(findLeaks('{"text":"St. Brigid Children\\u0027s Hospital"}', ["St. Brigid Children's Hospital"])).toHaveLength(1)
  })
})

describe('fixtures', () => {
  test('every labeled identifier appears in its note', () => {
    for (const n of fixtures.notes) for (const i of n.identifiers) expect(n.text).toContain(i.text)
  })
})
