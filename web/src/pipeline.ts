import { detectOnDevice } from './ai'
import type { Span } from './lib/detect'
import { findPatterns, mergeSpans, spansFromEntities } from './lib/detect'
import { findLeaks, redact } from './lib/vault'
import fixtures from '../../fixtures/notes.json'

export interface Fixture {
  id: string
  title: string
  task: string
  text: string
  split: 'tuning' | 'holdout'
  identifiers: { text: string; kind: string }[]
}

function isSplit(x: string): x is Fixture['split'] {
  return x === 'tuning' || x === 'holdout'
}

export const FIXTURES: Fixture[] = fixtures.notes.map((n) => ({ ...n, split: isSplit(n.split) ? n.split : 'tuning' }))

export interface Scan {
  spans: Span[]
  onDevice: boolean
  ms: number
}

// Patterns always run; the on-device model runs only when it is ready. There
// is no cloud path here by design.
export async function scan(note: string, deviceReady: boolean): Promise<Scan> {
  const t0 = performance.now()
  const pattern = findPatterns(note)
  if (!deviceReady) return { spans: mergeSpans(pattern), onDevice: false, ms: Math.round(performance.now() - t0) }
  const entities = await detectOnDevice(note)
  return {
    spans: mergeSpans([...pattern, ...spansFromEntities(note, entities)]),
    onDevice: true,
    ms: Math.round(performance.now() - t0),
  }
}

export interface AuditRow {
  id: string
  title: string
  split: Fixture['split']
  identifiers: number
  patternLeaks: string[]
  airlockLeaks: string[]
  held: number
  ms: number
}

// Measures one fixture: which labeled identifiers would still be in the text
// sent to the cloud, with patterns alone and with the full on-device scan.
export async function auditFixture(f: Fixture): Promise<AuditRow> {
  const truth = f.identifiers.map((i) => i.text)
  const patternOnly = redact(f.text, mergeSpans(findPatterns(f.text))).redacted
  const s = await scan(f.text, true)
  const { redacted, entries } = redact(f.text, s.spans)
  return {
    id: f.id,
    title: f.title,
    split: f.split,
    identifiers: truth.length,
    patternLeaks: findLeaks(patternOnly, truth),
    airlockLeaks: findLeaks(redacted, truth),
    held: entries.length,
    ms: s.ms,
  }
}
