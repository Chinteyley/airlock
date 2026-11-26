import { useState } from 'react'
import type { DeviceState } from '../ai'
import type { AuditRow } from '../pipeline'
import { auditFixture, FIXTURES } from '../pipeline'

const TOTAL_IDENTIFIERS = FIXTURES.reduce((n, f) => n + f.identifiers.length, 0)

export function AuditView({ device }: { device: DeviceState }) {
  const [rows, setRows] = useState<AuditRow[]>([])
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    setRunning(true)
    setError(null)
    setRows([])
    try {
      for (const f of FIXTURES) {
        const row = await auditFixture(f)
        setRows((r) => [...r, row])
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  const done = rows.length
  const counted = rows.reduce((n, r) => n + r.identifiers, 0)
  const airlockLeaks = rows.reduce((n, r) => n + r.airlockLeaks.length, 0)
  const patternLeaks = rows.reduce((n, r) => n + r.patternLeaks.length, 0)
  const meanMs = done ? rows.reduce((n, r) => n + r.ms, 0) / done : 0
  const splitLine = (split: AuditRow['split']) => {
    const part = rows.filter((r) => r.split === split)
    const leaked = part.reduce((n, r) => n + r.airlockLeaks.length, 0)
    const total = part.reduce((n, r) => n + r.identifiers, 0)
    return `${leaked} of ${total}`
  }

  return (
    <div className="page">
      <div className="row">
        <div>
          <h2 className="page-title">Audit on this device</h2>
          <p className="lede">
            {FIXTURES.length} synthetic clinical notes with {TOTAL_IDENTIFIERS} labeled identifiers (names, relatives,
            clinicians, facilities, places, dates, phones, emails, record numbers). Each note is scanned here, then the
            text that would go to the cloud is checked for every labeled value. Held-out notes were written after the
            detector was tuned and were never used to tune it.
          </p>
        </div>
        <span className="spacer" />
        <button type="button" className="btn primary" onClick={run} disabled={running || device !== 'ready'}>
          {running ? `Scanning ${done + 1} of ${FIXTURES.length}…` : 'Run the audit'}
        </button>
      </div>
      {device !== 'ready' && <div className="banner warn">The audit needs the on-device model. It is {device}.</div>}
      {error && <div className="banner danger">{error}</div>}

      <div className="cards">
        <div className="card">
          <h3>Leaked with Airlock</h3>
          <div className={`big ${airlockLeaks ? 'bad' : 'held'}`}>
            {done ? airlockLeaks : '–'}
            <span className="counter-of">of {done ? counted : TOTAL_IDENTIFIERS}</span>
          </div>
          {done > 0 && (
            <div className="muted">
              Tuning notes {splitLine('tuning')} · held-out notes {splitLine('holdout')}
            </div>
          )}
        </div>
        <div className="card">
          <h3>Leaked with patterns alone</h3>
          <div className="big bad">
            {done ? patternLeaks : '–'}
            <span className="counter-of">of {done ? counted : TOTAL_IDENTIFIERS}</span>
          </div>
        </div>
        <div className="card">
          <h3>Mean scan time</h3>
          <div className="big">{done ? `${(meanMs / 1000).toFixed(1)} s` : '–'}</div>
        </div>
      </div>

      {done > 0 && (
        <table>
          <thead>
            <tr>
              <th>Note</th>
              <th>Identifiers</th>
              <th>Patterns alone leak</th>
              <th>Airlock leaks</th>
              <th>Scan</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.title}
                  {r.split === 'holdout' && <span className="badge" style={{ marginLeft: 8 }}>HELD OUT</span>}
                </td>
                <td className="num">{r.identifiers}</td>
                <td className="num">
                  <span className="bad-text">{r.patternLeaks.length}</span>
                  <div className="leak">{r.patternLeaks.join(', ')}</div>
                </td>
                <td className="num">
                  <span className={r.airlockLeaks.length ? 'bad-text' : 'ok-text'}>{r.airlockLeaks.length}</span>
                  {r.airlockLeaks.length > 0 && <div className="leak">{r.airlockLeaks.join(', ')}</div>}
                </td>
                <td className="num">{(r.ms / 1000).toFixed(1)} s</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
