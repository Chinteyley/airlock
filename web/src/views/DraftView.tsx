import { useMemo, useRef, useState } from 'react'
import type { Draft, DeviceState } from '../ai'
import { buildDraftPrompt, detectOnDevice, draftLetter, userTextOf } from '../ai'
import { HeldNote, Tokens } from '../components/Marked'
import { kindName } from '../lib/kinds'
import type { Policy } from '../firebase'
import { saveDraft, sha256 } from '../history'
import type { Span } from '../lib/detect'
import { findPatterns, mergeSpans, nameParts, PERSON_KINDS, placeParts, spansFromEntities } from '../lib/detect'
import { TOKEN_RE } from '../lib/vault'
import type { VaultEntry } from '../lib/vault'
import { findLeaks, redact, restore, sealText } from '../lib/vault'
import type { WireRecord } from '../lib/wire'
import { lastWireId, wireSince } from '../lib/wire'
import { FIXTURES, patternSpans, scan } from '../pipeline'

type Phase = 'edit' | 'scanning' | 'review' | 'sending' | 'done'

interface Sent {
  draft: Draft
  // The vault as it was when the request went out; later edits can't change it.
  entries: VaultEntry[]
  wire: WireRecord[]
  leaks: string[]
}

type Saved = { state: 'saving' } | { state: 'saved' } | { state: 'failed'; error: string }

// Checks each captured body on its own, without Airlock's fixed template (so a
// held "Will" isn't matched in "you will never see").
function leaksIn(wire: WireRecord[], values: string[]): string[] {
  return [...new Set(wire.flatMap((w) => findLeaks(userTextOf(w.body), values)))]
}

const TASK_KINDS = new Set(['patient', 'relative', 'clinician', 'person', 'place'])

// People, places, numbers and dates typed into the task line that the note
// scan never saw. Services and programs ("a PTSD clinic") are what a task names.
async function unheldInTask(sealedTask: string, deviceReady: boolean): Promise<string[]> {
  const plain = sealedTask.replace(TOKEN_RE, ' ')
  const found = findPatterns(plain).map((s) => s.text)
  if (deviceReady) {
    const entities = await detectOnDevice(plain, { places: false })
    found.push(
      ...entities
        .filter((e) => TASK_KINDS.has(e.kind))
        .map((e) => e.text.trim())
        .filter((t) => t.length > 1 && plain.toLowerCase().includes(t.toLowerCase())),
    )
  }
  return [...new Set(found)]
}

function prettyBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    return body
  }
}

function endpointOf(url: string): string {
  const u = new URL(url)
  return `${u.host}${u.pathname}`
}

export function DraftView({ device, policy }: { device: DeviceState; policy: Policy }) {
  const [fixtureId, setFixtureId] = useState(FIXTURES[0].id)
  const [note, setNote] = useState(FIXTURES[0].text)
  const [task, setTask] = useState(FIXTURES[0].task)
  const [phase, setPhase] = useState<Phase>('edit')
  const [spans, setSpans] = useState<Span[]>([])
  const [scanMs, setScanMs] = useState(0)
  const [sealed, setSealed] = useState(false)
  const [reviewedPrompt, setReviewedPrompt] = useState<string | null>(null)
  const [selection, setSelection] = useState('')
  const [sent, setSent] = useState<Sent | null>(null)
  // A cloud attempt that failed with no on-device fallback, kept as evidence.
  const [attempt, setAttempt] = useState<WireRecord | null>(null)
  const [saved, setSaved] = useState<Saved | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showRestored, setShowRestored] = useState(true)
  // Values the clinician released; they stay released even where a held name contains them.
  const [released, setReleased] = useState<Set<string>>(new Set())
  // Bumped on every send and reset, so a late history save can't update a newer draft.
  const run = useRef(0)

  const redaction = useMemo(() => {
    const r = redact(note, spans)
    return { ...r, lookup: r.lookup.filter(([v]) => !released.has(v.toLowerCase())) }
  }, [note, spans, released])
  // Every held string, plus each part of a held name or place, is searched for in what goes out.
  const heldValues = useMemo(
    () =>
      [
        ...new Set(
          spans.flatMap((s) => {
            if (s.source === 'manual') return [s.text]
            return [s.text, ...(PERSON_KINDS.has(s.kind) ? nameParts(s.text) : placeParts(s.text))]
          }),
        ),
      ].filter((v) => !released.has(v.toLowerCase())),
    [spans, released],
  )
  const kindCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const e of redaction.entries) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1)
    return [...counts]
  }, [redaction])
  const restoration = useMemo(() => (sent ? restore(sent.draft.text, sent.entries) : null), [sent])
  const sealedTask = useMemo(() => sealText(task, redaction.lookup), [task, redaction])
  // The exact prompt the SDK will send: redacted note, sealed task, instructions.
  const outbound = useMemo(
    () => buildDraftPrompt(redaction.redacted, sealedTask, policy.draftInstructions),
    [policy, redaction, sealedTask],
  )
  // Everything but Airlock's fixed template is checked: instructions, task and note.
  const preflightLeaks = useMemo(
    () => findLeaks(`${policy.draftInstructions}\n${redaction.redacted}\n${sealedTask}`, heldValues),
    [policy, redaction, sealedTask, heldValues],
  )
  // A manual review confirms one exact prompt; any change asks for it again.
  const reviewed = reviewedPrompt === outbound

  const pickFixture = (id: string) => {
    const f = FIXTURES.find((x) => x.id === id)
    if (!f) return
    setFixtureId(id)
    setNote(f.text)
    setTask(f.task)
    reset()
  }

  const reset = () => {
    run.current += 1
    setPhase('edit')
    setSpans([])
    setReleased(new Set())
    setSent(null)
    setAttempt(null)
    setSaved(null)
    setError(null)
    setReviewedPrompt(null)
    setSelection('')
  }

  const runScan = async () => {
    setPhase('scanning')
    setError(null)
    const ready = device === 'ready'
    setSealed(!ready)
    try {
      const s = await scan(note, ready)
      setSpans(s.spans)
      setScanMs(s.ms)
      setPhase('review')
    } catch (e) {
      // The on-device scan failed: stay sealed and fall back to patterns plus review.
      setError(`On-device scan failed (${e instanceof Error ? e.message : String(e)}). Continuing sealed.`)
      setSealed(true)
      setSpans(patternSpans(note))
      setPhase('review')
    }
  }

  // Releasing a name also releases its parts held elsewhere in the same role
  // ("Maria" with "Maria Delgado"), never another person's.
  const release = (s: Span) => {
    if (phase !== 'review') return
    const norm = (t: string) => t.toLowerCase().replace(/\s+/g, ' ')
    const gone = new Set([s.text, ...(PERSON_KINDS.has(s.kind) ? nameParts(s.text) : [])].map(norm))
    setSpans((all) => all.filter((x) => !(x.kind === s.kind && gone.has(norm(x.text)))))
    setReleased((r) => new Set([...r, ...gone]))
  }

  const holdSelection = () => {
    const value = selection.trim()
    if (!value) return
    setSpans((all) => mergeSpans([...all, ...spansFromEntities(note, [{ text: value, kind: 'person' }], 'manual')], note))
    setSelection('')
    window.getSelection()?.removeAllRanges()
  }

  const readSelection = () => {
    const value = window.getSelection()?.toString().trim() ?? ''
    setSelection(value.length >= 2 && note.includes(value) ? value : '')
  }

  const send = async () => {
    if (preflightLeaks.length > 0) return
    run.current += 1
    const thisRun = run.current
    setPhase('sending')
    setError(null)
    const entries = redaction.entries
    try {
      const unheld = await unheldInTask(sealedTask, device === 'ready' && !sealed)
      if (unheld.length > 0) {
        setError(`The task line names ${unheld.join(', ')}. Take it out of the task, or put it in the note and scan again.`)
        setPhase('review')
        return
      }
      const since = lastWireId()
      const draft = await draftLetter(outbound, policy.draftModel).catch((e: unknown) => {
        setAttempt(wireSince(since).at(-1) ?? null)
        throw e
      })
      const wire = wireSince(since)
      const leaks = leaksIn(wire, heldValues)
      if (thisRun !== run.current) return
      setSent({ draft, entries, wire, leaks })
      setPhase('done')
      // History syncs on its own; the letter never waits for it.
      setSaved({ state: 'saving' })
      const save = async () => {
        const payload = wire.map((w) => w.body).join('\n')
        await saveDraft(
          {
            title: FIXTURES.find((f) => f.id === fixtureId && f.text === note)?.title ?? 'Referral letter',
            platform: 'web',
            redactedNote: redaction.redacted,
            redactedLetter: draft.text,
            held: entries.length,
            leaked: leaks.length,
            detectedOn: sealed ? 'patterns-only' : 'on-device',
            draftedOn: draft.source,
            payloadSha256: wire.length && crypto.subtle ? await sha256(payload) : null,
          },
          heldValues,
        )
      }
      save()
        .then(() => thisRun === run.current && setSaved({ state: 'saved' }))
        .catch(
          (e: unknown) =>
            thisRun === run.current && setSaved({ state: 'failed', error: e instanceof Error ? e.message : String(e) }),
        )
    } catch (e) {
      if (thisRun !== run.current) return
      setError(e instanceof Error ? e.message : String(e))
      setPhase('review')
    }
  }

  const canSend = phase === 'review' && preflightLeaks.length === 0 && (!sealed || reviewed)
  const lastWire = sent?.wire.at(-1) ?? attempt ?? undefined

  return (
    <div className="stage">
      <section className="col" aria-label="This device">
        <div className="col-head">
          <span className="col-title">This device</span>
          <span className="badge held">ONLY_ON_DEVICE · Gemini Nano</span>
        </div>
        <div className="col-body">
          {phase === 'edit' || phase === 'scanning' ? (
            <>
              <label className="field">
                Sample note (synthetic)
                <select value={fixtureId} onChange={(e) => pickFixture(e.target.value)} disabled={phase === 'scanning'}>
                  {FIXTURES.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Clinical note
                <textarea
                  className="note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  disabled={phase === 'scanning'}
                  spellCheck={false}
                />
              </label>
            </>
          ) : (
            <>
              <div className="kinds" aria-label="Held identifiers by kind">
                {kindCounts.map(([kind, n]) => (
                  <span key={kind} className="kind">
                    <b>{n}</b>
                    {kindName(kind)}
                  </span>
                ))}
              </div>
              {sealed && (
                <div className="banner warn">
                  <strong>Sealed.</strong> No on-device model is ready, so Airlock won't scan with AI, and it never sends
                  the raw note to the cloud instead. Patterns held {spans.length} values. Select any name or place
                  patterns missed to hold it, then confirm below.
                </div>
              )}
              <div onMouseUp={readSelection} onKeyUp={readSelection} role="presentation">
                <HeldNote text={note} spans={spans} onRelease={release} />
              </div>
            </>
          )}
          {error && <div className="banner danger">{error}</div>}
        </div>
        <div className="col-foot">
          {phase === 'edit' && (
            <button type="button" className="btn primary" onClick={runScan} disabled={!note.trim() || device === 'checking'}>
              Scan on this device
            </button>
          )}
          {phase === 'scanning' && (
            <span className="row muted">
              <span className="spinner" /> Scanning on this device…
            </span>
          )}
          {phase !== 'edit' && phase !== 'scanning' && (
            <>
              <span className="muted">
                {sealed ? 'Held by patterns and by hand' : `Scanned on this device in ${(scanMs / 1000).toFixed(1)} s`}
              </span>
              {selection && phase === 'review' && (
                <button type="button" className="btn small" onClick={holdSelection}>
                  Hold “{selection.length > 24 ? `${selection.slice(0, 24)}…` : selection}”
                </button>
              )}
              <span className="spacer" />
              <button type="button" className="btn small" onClick={reset} disabled={phase === 'sending'}>
                Edit note
              </button>
            </>
          )}
        </div>
      </section>

      <section className="col wire" aria-label="The wire">
        <div className="col-head">
          <span className="col-title">The wire</span>
          <span className="badge">{lastWire ? 'CAPTURED · fetch' : 'OUTBOUND'}</span>
        </div>
        <div className="col-body">
          {phase === 'edit' || phase === 'scanning' ? (
            <div className="empty">Nothing has left this device.</div>
          ) : (
            <>
              <div className="counter">
                <span className="counter-label">
                  {sent ? 'Held identifiers in the captured request' : 'Held identifiers in the outbound prompt'}
                </span>
                <span className={`counter-value${(sent ? sent.leaks : preflightLeaks).length > 0 ? ' bad' : ''}`}>
                  {(sent ? sent.leaks : preflightLeaks).length}
                  <span className="counter-of">of {redaction.entries.length} held</span>
                </span>
              </div>
              {!sent && preflightLeaks.length > 0 && (
                <div className="banner danger">
                  The prompt still contains {preflightLeaks.join(', ')}
                  {findLeaks(sealedTask, preflightLeaks).length > 0 ? ' in the task line. Use the full name there or take it out.' : '. Airlock won’t send it until that’s held.'}
                </div>
              )}
              {sent && !lastWire && (
                <div className="banner ok">No request left this device: the letter was drafted on-device.</div>
              )}
              {sent && lastWire && sent.draft.source === 'ON_DEVICE' && (
                <div className="banner warn">
                  The cloud request {lastWire.status ? `failed (${lastWire.status})` : 'could not connect'}, so the
                  letter was drafted on this device. The request below is what was attempted.
                </div>
              )}
              {lastWire ? (
                <>
                  <div className="endpoint">
                    POST {endpointOf(lastWire.url)} → {lastWire.status === null ? '…' : lastWire.status || 'failed'}
                  </div>
                  <div className="payload">
                    <Tokens text={prettyBody(lastWire.body)} />
                  </div>
                </>
              ) : (
                <>
                  <div className="muted">The exact prompt the cloud will see:</div>
                  <div className="payload">
                    <Tokens text={outbound} />
                  </div>
                </>
              )}
              {sealed && phase === 'review' && (
                <label className="row muted">
                  <input type="checkbox" checked={reviewed} onChange={(e) => setReviewedPrompt(e.target.checked ? outbound : null)} />I read the
                  prompt above, and it names no one.
                </label>
              )}
            </>
          )}
        </div>
        <div className="col-foot">
          <label className="field" style={{ flex: 1 }}>
            Letter to write
            <input type="text" value={task} onChange={(e) => setTask(e.target.value)} disabled={phase === 'sending' || phase === 'done'} />
          </label>
          <button type="button" className="btn cloud" onClick={send} disabled={!canSend}>
            {phase === 'sending' ? 'Drafting…' : 'Send through the airlock'}
          </button>
        </div>
      </section>

      <section className="col" aria-label="The letter">
        <div className="col-head">
          <span className="col-title">The letter</span>
          {sent && (
            <span className={`badge ${sent.draft.source === 'IN_CLOUD' ? 'cloud' : 'held'}`}>
              {sent.draft.source} · {sent.draft.source === 'IN_CLOUD' ? policy.draftModel : 'Gemini Nano'}
            </span>
          )}
          <span className="spacer" />
          {sent && (
            <div className="seg" role="group" aria-label="Letter view">
              <button type="button" aria-pressed={showRestored} onClick={() => setShowRestored(true)}>
                Restored
              </button>
              <button type="button" aria-pressed={!showRestored} onClick={() => setShowRestored(false)}>
                As the cloud wrote it
              </button>
            </div>
          )}
        </div>
        <div className="col-body">
          {phase === 'sending' && (
            <div className="empty">
              <span className="row">
                <span className="spinner" /> Drafting on the redacted note…
              </span>
            </div>
          )}
          {sent && restoration ? (
            <>
              <div className="letter">
                <Tokens text={sent.draft.text} entries={sent.entries} restore={showRestored} />
              </div>
              {restoration.unknown.length > 0 && (
                <div className="banner warn">
                  The draft used tokens Airlock never issued: {restoration.unknown.join(', ')}. They were left as they
                  are.
                </div>
              )}
            </>
          ) : (
            phase !== 'sending' && <div className="empty">The letter comes back here, and names are restored on this device.</div>
          )}
        </div>
        {sent && restoration && (
          <div className="col-foot">
            <span className="muted">
              {restoration.restored} values restored on this device · drafted in {(sent.draft.ms / 1000).toFixed(1)} s
              {saved?.state === 'saved' ? ' · redacted copy saved' : ''}
              {saved?.state === 'saving' ? ' · saving redacted copy…' : ''}
            </span>
            <span className="spacer" />
            <button
              type="button"
              className="btn small"
              onClick={() => navigator.clipboard.writeText(showRestored ? restoration.text : sent.draft.text)}
            >
              {showRestored ? 'Copy letter' : 'Copy tokenized letter'}
            </button>
          </div>
        )}
        {saved?.state === 'failed' && <div className="banner danger">{saved.error}</div>}
      </section>
    </div>
  )
}
