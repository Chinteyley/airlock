// Firestore keeps what the clinician might want again: the redacted note and
// the letter as the cloud wrote it, tokens and all. Real values stay in the
// browser tab that held them, so the database can't leak what it never had.

import type { Timestamp } from 'firebase/firestore'
import { addDoc, collection, limit, onSnapshot, orderBy, query, serverTimestamp } from 'firebase/firestore'
import { authReady, db } from './firebase'
import { findLeaks } from './lib/vault'

export interface DraftRecord {
  title: string
  platform: 'web' | 'ios'
  redactedNote: string
  redactedLetter: string
  held: number
  leaked: number
  detectedOn: 'on-device' | 'patterns-only'
  draftedOn: 'IN_CLOUD' | 'ON_DEVICE'
  payloadSha256: string | null
}

export interface StoredDraft extends DraftRecord {
  id: string
  createdAt: Timestamp | null
}

export async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Refuses to write a record that contains any held value.
export async function saveDraft(record: DraftRecord, heldValues: string[]): Promise<string> {
  const leaks = findLeaks(JSON.stringify(record), heldValues)
  if (leaks.length > 0) throw new Error(`Refusing to store: ${leaks.length} held values found in the record.`)
  const user = await authReady
  const ref = await addDoc(collection(db, 'users', user.uid, 'drafts'), { ...record, createdAt: serverTimestamp() })
  return ref.id
}

export function watchDrafts(uid: string, onChange: (drafts: StoredDraft[]) => void): () => void {
  const q = query(collection(db, 'users', uid, 'drafts'), orderBy('createdAt', 'desc'), limit(25))
  return onSnapshot(q, (snap) => {
    onChange(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<StoredDraft, 'id'>) })))
  })
}
