// Swaps held identifiers for typed tokens before anything leaves the device,
// and swaps them back afterwards. Both directions are plain string work, so
// restoring never depends on a model getting it right.

import type { Kind, Span } from './detect'
import { nameParts, PERSON_KINDS } from './detect'

const LABEL: Record<Kind, string> = {
  patient: 'PATIENT',
  relative: 'RELATIVE',
  clinician: 'CLINICIAN',
  person: 'PERSON',
  organization: 'ORG',
  address: 'PLACE',
  date: 'DATE',
  dob: 'DOB',
  phone: 'PHONE',
  email: 'EMAIL',
  record: 'ID',
  url: 'URL',
}

export interface VaultEntry {
  token: string
  value: string
  kind: Kind
}

export interface Redaction {
  redacted: string
  entries: VaultEntry[]
  // Every held string (full values and name parts) and the token it maps to.
  lookup: [string, string][]
}

export const TOKEN_RE = /\[([A-Z]+)_(\d+)\]/g

const MS_PER_YEAR = 365.2425 * 24 * 3600 * 1000
const OLDEST_EXACT_AGE = 89

// Safe Harbor allows an age, not a birth date; ages over 89 are grouped.
export function ageLabel(dob: string, today: Date): string | null {
  const m = dob.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (!m) return null
  const year = m[3].length === 2 ? 1900 + Number(m[3]) : Number(m[3])
  const born = new Date(year, Number(m[1]) - 1, Number(m[2]))
  const age = Math.floor((today.getTime() - born.getTime()) / MS_PER_YEAR)
  if (Number.isNaN(age) || age < 0) return null
  return age > OLDEST_EXACT_AGE ? 'age 90+' : `age ${age}`
}

function key(value: string) {
  return value.toLowerCase()
}

export function redact(text: string, spans: Span[], today = new Date()): Redaction {
  const byValue = new Map<string, VaultEntry>()
  const counters = new Map<string, number>()
  const entries: VaultEntry[] = []

  const issue = (value: string, kind: Kind): VaultEntry => {
    const label = LABEL[kind]
    const n = (counters.get(label) ?? 0) + 1
    counters.set(label, n)
    const entry = { token: `[${label}_${n}]`, value, kind }
    byValue.set(key(value), entry)
    entries.push(entry)
    return entry
  }

  // Full names first, so a lone "Maria" shares the token of "Maria Delgado"
  // when exactly one held name of the same role contains that part.
  const ordered = [...spans].sort((a, b) => b.text.length - a.text.length)
  const partOwners = new Map<string, Set<string>>()
  for (const s of ordered) {
    if (!PERSON_KINDS.has(s.kind)) continue
    for (const p of nameParts(s.text)) {
      if (p === s.text) continue
      const owners = partOwners.get(key(p)) ?? new Set<string>()
      owners.add(key(s.text))
      partOwners.set(key(p), owners)
    }
  }
  for (const s of ordered) {
    if (byValue.has(key(s.text))) continue
    const owners = partOwners.get(key(s.text))
    const owner = owners?.size === 1 ? byValue.get([...owners][0]) : undefined
    if (owner && owner.kind === s.kind) byValue.set(key(s.text), owner)
    else issue(s.text, s.kind)
  }

  let out = ''
  let at = 0
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    const entry = byValue.get(key(s.text))
    if (!entry) continue
    out += text.slice(at, s.start) + entry.token
    if (s.kind === 'dob') {
      const age = ageLabel(s.text, today)
      if (age) out += ` (${age})`
    }
    at = s.end
  }
  out += text.slice(at)
  const lookup = [...new Set(spans.map((s) => s.text))].map((v): [string, string] => [v, byValue.get(key(v))?.token ?? ''])
  return { redacted: out, entries, lookup }
}

// Swaps every held string in some other text (the task line, say) for its
// token, longest first, whole words only.
export function sealText(text: string, lookup: [string, string][]): string {
  let out = text
  for (const [value, token] of [...lookup].sort((a, b) => b[0].length - a[0].length)) {
    if (!token) continue
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(value)}(?![\\p{L}\\p{N}])`, 'giu'), token)
  }
  return out
}

export interface Restoration {
  text: string
  restored: number
  unknown: string[]
}

export function restore(text: string, entries: VaultEntry[]): Restoration {
  const byToken = new Map(entries.map((e) => [e.token, e.value]))
  let restored = 0
  const unknown = new Set<string>()
  const out = text.replace(TOKEN_RE, (token) => {
    const value = byToken.get(token)
    if (value === undefined) {
      unknown.add(token)
      return token
    }
    restored += 1
    return value
  })
  return { text: out, restored, unknown: [...unknown] }
}

function strings(value: unknown, out: string[]): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const v of value) strings(v, out)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) strings(v, out)
  return out
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Every held value found as a whole word in an outbound payload: in the raw
// body, and in the decoded strings when the body is JSON (so escapes like
// ' can't hide a match).
export function findLeaks(payload: string, values: string[]): string[] {
  const haystacks = [payload]
  try {
    haystacks.push(strings(JSON.parse(payload), []).join('\n'))
  } catch {
    // Not JSON; the raw body is enough.
  }
  const found = new Set<string>()
  for (const v of values) {
    if (v.length < 2 || found.has(v.toLowerCase())) continue
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(v)}(?![\\p{L}\\p{N}])`, 'iu')
    if (haystacks.some((h) => re.test(h))) found.add(v.toLowerCase())
  }
  return [...found]
}
