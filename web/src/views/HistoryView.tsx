import { useEffect, useState } from 'react'
import { Tokens } from '../components/Marked'
import { authReady } from '../firebase'
import type { StoredDraft } from '../history'
import { watchDrafts } from '../history'

export function HistoryView() {
  const [drafts, setDrafts] = useState<StoredDraft[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let stop: (() => void) | undefined
    let cancelled = false
    authReady
      .then((user) => {
        if (!cancelled) stop = watchDrafts(user.uid, setDrafts)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
      stop?.()
    }
  }, [])

  return (
    <div className="page">
      <div>
        <h2 className="page-title">What the database holds</h2>
        <p className="lede">
          Every letter is saved to Firestore as the cloud wrote it, with tokens in place of names. The real values never
          leave the device that held them, so this history holds no one’s name.
        </p>
      </div>
      {error && <div className="banner danger">{error}</div>}
      {drafts === null && !error && <div className="muted">Loading…</div>}
      {drafts?.length === 0 && <div className="muted">No letters yet.</div>}
      {drafts?.map((d) => (
        <article key={d.id} className="history-item">
          <div className="row">
            <strong>{d.title}</strong>
            <span className="badge">{d.platform.toUpperCase()}</span>
            <span className={`badge ${d.draftedOn === 'IN_CLOUD' ? 'cloud' : 'held'}`}>{d.draftedOn}</span>
            <span className="spacer" />
            <span className="muted">
              {d.held} held · {d.leaked} leaked · {d.createdAt?.toDate().toLocaleString() ?? 'saving…'}
            </span>
          </div>
          <div className="excerpt">
            <Tokens text={d.redactedLetter} />
          </div>
        </article>
      ))}
    </div>
  )
}
