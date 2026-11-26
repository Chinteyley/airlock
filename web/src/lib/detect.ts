// Finds identifiers in a note. Pattern detectors catch structured values
// (phones, emails, record numbers, dates, street addresses); the on-device
// model catches what patterns can't (names, relatives, facilities, places).
// Both produce spans over the original text, merged here.

export type Kind =
  | 'patient'
  | 'relative'
  | 'clinician'
  | 'person'
  | 'organization'
  | 'address'
  | 'date'
  | 'dob'
  | 'phone'
  | 'email'
  | 'record'
  | 'url'

export type Source = 'pattern' | 'on-device' | 'manual'

export interface Span {
  start: number
  end: number
  text: string
  kind: Kind
  source: Source
}

export const PERSON_KINDS: ReadonlySet<Kind> = new Set(['patient', 'relative', 'clinician', 'person'])

const MONTHS = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?'
const STREET =
  'Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr|Boulevard|Blvd|Court|Ct|Way|Place|Pl|Terrace|Circle|Highway|Hwy|Parkway|Pkwy'

interface Pattern {
  kind: Kind
  re: RegExp
  // Capture group holding the identifier, when the match includes a label.
  group?: number
}

const PATTERNS: Pattern[] = [
  { kind: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: 'url', re: /\bhttps?:\/\/[^\s)]+/g },
  { kind: 'record', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { kind: 'phone', re: /(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b/g },
  { kind: 'date', re: /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g },
  { kind: 'date', re: /\b\d{4}-\d{2}-\d{2}\b/g },
  { kind: 'date', re: new RegExp(`\\b(?:${MONTHS})\\.? \\d{1,2},? \\d{4}\\b`, 'g') },
  {
    kind: 'record',
    re: /\b(?:MRN|medical record(?: number)?|member ID|Medicaid ID|Medicare ID|student ID|patient ID|account(?: number)?|policy(?: number)?|SSN|social security number(?: on intake)?|ID)\b[\s:#]*((?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{4,})/gi,
    group: 1,
  },
  { kind: 'address', re: new RegExp(`\\b\\d{1,6}\\s+(?:[A-Z][a-z]+\\s){1,3}(?:${STREET})\\b\\.?`, 'g') },
  // City before a state code: "Fresno, CA".
  { kind: 'address', re: /\b([A-Z][a-z]+(?: [A-Z][a-z]+)?),\s[A-Z]{2}\b/g, group: 1 },
  // ZIP after a state code: "CA 93721".
  { kind: 'address', re: /\b[A-Z]{2}\s(\d{5}(?:-\d{4})?)\b/g, group: 1 },
  // A capitalized name right after a relation word: "her sister Emiko".
  {
    kind: 'relative',
    re: /\b(?:sister|brother|son|daughter|wife|husband|mother|mom|father|dad|partner|roommate|friend|aunt|uncle|cousin|niece|nephew|grandson|granddaughter|grandmother|grandfather|fiancée?|boyfriend|girlfriend)\b,?\s+(\p{Lu}\p{Ll}+(?:[\s-]\p{Lu}\p{Ll}+)?)/gu,
    group: 1,
  },
  // A capitalized name after a title: "Dr. Alan Whitcomb", "Officer Dana Whitfield".
  {
    kind: 'person',
    re: /\b(?:Dr|Mr|Mrs|Ms|Mx|Officer|Nurse|Coach)\.?\s+(\p{Lu}\p{Ll}+(?:[\s-]\p{Lu}\p{Ll}+)*)/gu,
    group: 1,
  },
]

const DOB_CUE = /(?:DOB|D\.O\.B\.|born|date of birth|birth ?date)[\s:(]*$/i

export function findPatterns(text: string): Span[] {
  const spans: Span[] = []
  for (const { kind, re, group } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const value = group ? m[group] : m[0]
      if (!value) continue
      const start = m.index + m[0].indexOf(value)
      let k = kind
      if (k === 'date' && DOB_CUE.test(text.slice(Math.max(0, start - 18), start))) k = 'dob'
      spans.push({ start, end: start + value.length, text: value, kind: k, source: 'pattern' })
    }
  }
  return spans
}

// What the on-device model returns for one entity.
export interface ModelEntity {
  text: string
  kind: string
}

const MODEL_KINDS: Record<string, Kind> = {
  patient: 'patient',
  relative: 'relative',
  clinician: 'clinician',
  person: 'person',
  organization: 'organization',
  place: 'address',
}

const TITLES = new Set(['dr', 'mr', 'mrs', 'ms', 'mx', 'miss', 'officer', 'nurse', 'the', 'and'])

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function occurrences(text: string, needle: string): number[] {
  const out: number[] = []
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(needle)}(?![\\p{L}\\p{N}])`, 'gu')
  for (const m of text.matchAll(re)) out.push(m.index)
  return out
}

// Name parts ("Maria" from "Maria Delgado") so later mentions are held too.
export function nameParts(name: string): string[] {
  return name
    .split(/\s+/)
    .map((p) => p.replace(/^["'(]+|["'),.;:]+$/g, ''))
    .filter((p) => p.length >= 3 && /^\p{Lu}/u.test(p) && !TITLES.has(p.toLowerCase()))
}

// Turns model entities into spans: every occurrence of each entity, and of
// each part of a person's name, anywhere in the note.
export function spansFromEntities(text: string, entities: ModelEntity[], source: Source = 'on-device'): Span[] {
  const spans: Span[] = []
  for (const e of entities) {
    const kind = MODEL_KINDS[e.kind] ?? 'person'
    const value = e.text.trim().replace(/^(?:Dr|Mr|Mrs|Ms|Mx)\.?\s+/, '')
    if (value.length < 2 || !text.includes(value)) continue
    const needles = PERSON_KINDS.has(kind) ? [value, ...nameParts(value)] : [value, ...placeParts(value)]
    for (const n of needles) {
      for (const start of occurrences(text, n)) {
        spans.push({ start, end: start + n.length, text: n, kind, source })
      }
    }
  }
  return spans
}

// Generic words in organization and place names, which say nothing on their own.
const GENERIC = new Set(
  'family medicine medical center centre hospital clinic clinics health healthcare behavioral services service care partners associates group school high elementary academy university college county city state regional general community memorial children\'s women\'s mercy saint st. st north south east west northside southside the of and at for on street avenue road lane drive court boulevard program programs recovery hospice physical therapy motion teen club bank golf packing'.split(
    ' ',
  ),
)

// Distinctive words of a held place or organization ("Ames" from "Ames
// Family Medicine"), so the same place mentioned on its own is held too.
export function placeParts(value: string): string[] {
  const words = value.split(/\s+/)
  if (words.length < 2) return []
  return words.filter((w) => w.length >= 3 && /^\p{Lu}\p{Ll}/u.test(w) && !GENERIC.has(w.toLowerCase()))
}

const RANK: Record<Source, number> = { manual: 3, pattern: 2, 'on-device': 1 }

// Keeps the longest span where spans overlap; on a tie, manual beats pattern beats model.
export function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort(
    (a, b) => b.end - b.start - (a.end - a.start) || RANK[b.source] - RANK[a.source] || a.start - b.start,
  )
  const kept: Span[] = []
  for (const s of sorted) {
    if (kept.every((k) => s.end <= k.start || s.start >= k.end)) kept.push(s)
  }
  return kept.sort((a, b) => a.start - b.start)
}
