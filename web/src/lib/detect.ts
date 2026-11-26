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

const STATES =
  'AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|PR'

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
  { kind: 'date', re: new RegExp(`\\b\\d{1,2} (?:${MONTHS})\\.?,? \\d{4}\\b`, 'g') },
  {
    kind: 'record',
    re: /\b(?:MRN|medical record(?: number)?|member ID|Medicaid ID|Medicare ID|student ID|patient ID|account(?: number)?|policy(?: number)?|chart(?: number)?|case(?: number)?|file(?: number)?|claim(?: number)?|SSN|social security number(?: on intake)?|ID)\b[\s:#]*((?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{4,})/gi,
    group: 1,
  },
  // After the labeled record numbers, so "Medicaid ID 0039948217" stays a record.
  { kind: 'phone', re: /(?:\+\d{1,3}[\s.-]?)?\b\d{10,11}\b/g },
  { kind: 'address', re: new RegExp(`\\b\\d{1,6}\\s+(?:[A-Z][a-z]+\\s){1,3}(?:${STREET})\\b\\.?`, 'g') },
  // City before a state code: "Fresno, CA".
  // MD and PA are left out here: "Alan Whitcomb, MD" is a clinician, not a city.
  {
    kind: 'address',
    re: new RegExp(`\\b([A-Z][a-z]+(?: [A-Z][a-z]+)?),\\s(?:${STATES.replace('|MD', '').replace('|PA', '')})\\b`, 'g'),
    group: 1,
  },
  // ZIP after a state code: "CA 93721".
  { kind: 'address', re: new RegExp(`\\b(?:${STATES})\\s(\\d{5}(?:-\\d{4})?)\\b`, 'g'), group: 1 },
  // A capitalized name right after a relation word: "her sister Emiko".
  {
    kind: 'relative',
    re: /\b(?:sister|brother|son|daughter|wife|husband|mother|mom|father|dad|partner|roommate|friend|aunt|uncle|cousin|niece|nephew|grandson|granddaughter|grandmother|grandfather|fiancée?|boyfriend|girlfriend)\b,?[ \t]+(?:(?:Mr|Mrs|Ms|Mx|Dr)\.?[ \t]+)?(\p{Lu}\p{Ll}+(?:[ \t-]\p{Lu}\p{Ll}+)?)/gu,
    group: 1,
  },
  // A capitalized name after a title: "Dr. Alan Whitcomb", "Officer Dana Whitfield".
  {
    kind: 'person',
    re: /\b(?:Dr|Mr|Mrs|Ms|Mx|Officer|Nurse|Coach)\.?[ \t]+(\p{Lu}\p{Ll}+(?:[ \t-]\p{Lu}\p{Ll}+)*)/gu,
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

function titleCase(s: string) {
  return s.replace(/\p{L}+/gu, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
}

// Names that are also everyday words. Held as written, in capitals or
// title-cased only, so a held "Will" doesn't swallow every "will".
const WORD_NAMES = new Set(
  'will may june april august rose ray hope faith grace joy mark bill art dawn iris ivy jack sue pat rich frank hunter summer autumn sky star angel chance cash chase page price wade young long white brown black green gray grey king bishop love hall mercy major dean bell rob guy max sunny'.split(
    ' ',
  ),
)

// How a held value is found anywhere (the note, the task line, a captured
// request): in any case, with any whitespace between its words, and only as a
// whole word ("_" counts as a word character, so "DATE" never matches inside
// a "[DATE_1]" token).
export function heldPattern(value: string, flags = 'gu'): RegExp {
  const words = value.trim().split(/\s+/)
  const body = (v: string) => v.trim().split(/\s+/).map(escapeRe).join('\\s+')
  const wordName = words.length === 1 && WORD_NAMES.has(value.toLowerCase())
  const alternatives = wordName ? [...new Set([value, value.toUpperCase(), titleCase(value)])].map(body) : [body(value)]
  const f = wordName ? flags : `${flags}i`
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}_])`, f)
}

function occurrences(text: string, needle: string): { start: number; text: string }[] {
  return [...text.matchAll(heldPattern(needle))].map((m) => ({ start: m.index, text: m[0] }))
}

const SHORT_WORDS = new Set(['in', 'on', 'at', 'to', 'of', 'or', 'as', 'is', 'it', 'no', 'so', 'he', 'we', 'my', 'by', 'up', 'do', 'go', 'an', 'am', 'be', 'me', 'us', 'if'])

// Name parts ("Maria" from "Maria Delgado", "Tanaka" and "Reyes" from
// "Tanaka-Reyes") so later mentions are held too.
export function nameParts(name: string): string[] {
  const words = name.split(/\s+/).map((p) => p.replace(/^["'(]+|["'),.;:]+$/g, ''))
  const pieces = [...words, ...words.filter((w) => w.includes('-')).flatMap((w) => w.split('-'))]
  return [
    ...new Set(
      pieces.filter(
        (p) =>
          p.length >= 2 &&
          p !== name &&
          /^\p{Lu}/u.test(p) &&
          !TITLES.has(p.toLowerCase()) &&
          !SHORT_WORDS.has(p.toLowerCase()),
      ),
    ),
  ]
}

// Turns model entities into spans: every occurrence of each entity, and of
// each part of a person's name, anywhere in the note.
export function spansFromEntities(text: string, entities: ModelEntity[], source: Source = 'on-device'): Span[] {
  const spans: Span[] = []
  for (const e of entities) {
    const kind = MODEL_KINDS[e.kind] ?? 'person'
    const value = e.text.trim().replace(/^(?:Dr|Mr|Mrs|Ms|Mx)\.?\s+/, '')
    if (value.length < 2) continue
    // Parts are tried even when the full value isn't in the note verbatim. A
    // manual hold is held exactly as selected, without parts.
    const parts = PERSON_KINDS.has(kind) ? nameParts(value) : placeParts(value)
    const needles = source === 'manual' ? [value] : [value, ...parts]
    for (const n of needles) {
      for (const o of occurrences(text, n)) {
        spans.push({ start: o.start, end: o.start + o.text.length, text: o.text, kind, source })
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

// Every occurrence of every span's text (and of a person's name parts), so a
// value found once, by any detector, is held everywhere it appears.
export function expandSpans(text: string, spans: Span[]): Span[] {
  const out = [...spans]
  const seen = new Set<string>()
  for (const s of spans) {
    const k = `${s.kind}:${s.text.toLowerCase()}`
    if (seen.has(k) || s.source === 'manual') continue
    seen.add(k)
    const needles = [s.text, ...(PERSON_KINDS.has(s.kind) ? nameParts(s.text) : [])]
    for (const n of needles) {
      for (const o of occurrences(text, n)) {
        out.push({ start: o.start, end: o.start + o.text.length, text: o.text, kind: s.kind, source: s.source })
      }
    }
  }
  return out
}

const RANK: Record<Source, number> = { manual: 3, pattern: 2, 'on-device': 1 }

// Overlapping spans become one span covering all of them, so no detector can
// shrink what another one held. The longest span (manual, then pattern, then
// model on a tie) names the kind.
export function mergeSpans(spans: Span[], text: string): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end)
  const out: Span[] = []
  for (const s of sorted) {
    const last = out.at(-1)
    if (!last || s.start >= last.end) {
      out.push({ ...s })
      continue
    }
    const lead =
      s.end - s.start > last.end - last.start ||
      (s.end - s.start === last.end - last.start && RANK[s.source] > RANK[last.source])
    const end = Math.max(last.end, s.end)
    const merged = lead ? { ...s, start: last.start, end } : { ...last, end }
    merged.text = text.slice(merged.start, merged.end)
    out[out.length - 1] = merged
  }
  return out
}
