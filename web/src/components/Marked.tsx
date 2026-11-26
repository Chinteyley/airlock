import type { ReactNode } from 'react'
import type { Span } from '../lib/detect'
import { TOKEN_RE } from '../lib/vault'
import type { VaultEntry } from '../lib/vault'
import { kindName } from '../lib/kinds'

// The note with every held span marked. Clicking a mark releases it.
export function HeldNote({ text, spans, onRelease }: { text: string; spans: Span[]; onRelease: (s: Span) => void }) {
  const parts: ReactNode[] = []
  let at = 0
  for (const s of spans) {
    if (s.start > at) parts.push(text.slice(at, s.start))
    parts.push(
      <mark
        key={`${s.start}-${s.end}`}
        className={`held${s.source === 'manual' ? ' manual' : ''}`}
        title={`${kindName(s.kind)} · found by ${s.source} · click to release`}
        onClick={() => onRelease(s)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onRelease(s)
        }}
        tabIndex={0}
      >
        {text.slice(s.start, s.end)}
      </mark>,
    )
    at = s.end
  }
  parts.push(text.slice(at))
  return <div className="note-view">{parts}</div>
}

// Text with tokens shown as pills, or swapped for their real values.
export function Tokens({ text, entries, restore }: { text: string; entries?: VaultEntry[]; restore?: boolean }) {
  const byToken = new Map((entries ?? []).map((e) => [e.token, e.value]))
  const parts: ReactNode[] = []
  let at = 0
  for (const m of text.matchAll(TOKEN_RE)) {
    if (m.index > at) parts.push(text.slice(at, m.index))
    const value = byToken.get(m[0])
    parts.push(
      restore && value !== undefined ? (
        <mark key={m.index} className="restored" title={`${m[0]}, restored on this device`}>
          {value}
        </mark>
      ) : (
        <span key={m.index} className="token">
          {m[0]}
        </span>
      ),
    )
    at = m.index + m[0].length
  }
  parts.push(text.slice(at))
  return <>{parts}</>
}
