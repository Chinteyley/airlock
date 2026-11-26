// Records the literal body of every request the app sends to Firebase AI
// Logic, by wrapping fetch where the SDK calls it. The wire panel and the leak
// scan read from here, so "sent to the cloud" means what actually went out.

export interface WireRecord {
  id: number
  at: number
  url: string
  body: string
}

const AI_HOSTS = ['firebasevertexai.googleapis.com', 'generativelanguage.googleapis.com']

type Listener = (records: WireRecord[]) => void

let records: WireRecord[] = []
const listeners = new Set<Listener>()
let nextId = 1

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function bodyText(body: BodyInit | null | undefined): string {
  if (typeof body === 'string') return body
  if (body instanceof URLSearchParams) return body.toString()
  return body ? `[${Object.prototype.toString.call(body)}]` : ''
}

export function installWire() {
  const original = window.fetch.bind(window)
  if ((window.fetch as { __airlock?: boolean }).__airlock) return
  const wrapped = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input)
    if (AI_HOSTS.some((h) => url.includes(h))) {
      records = [...records, { id: nextId++, at: Date.now(), url, body: bodyText(init?.body) }]
      for (const l of listeners) l(records)
    }
    return original(input, init)
  }
  Object.assign(wrapped, { __airlock: true })
  window.fetch = wrapped
}

export function onWire(listener: Listener): () => void {
  listeners.add(listener)
  listener(records)
  return () => listeners.delete(listener)
}

export function wireSince(id: number): WireRecord[] {
  return records.filter((r) => r.id > id)
}

export function lastWireId(): number {
  return records.at(-1)?.id ?? 0
}
