import { useEffect, useState } from 'react'
import type { DeviceState } from './ai'
import { deviceState, preloadDevice, warmDevice } from './ai'
import type { Policy } from './firebase'
import { DEFAULT_POLICY, policyReady } from './firebase'
import { AuditView } from './views/AuditView'
import { DraftView } from './views/DraftView'
import { HistoryView } from './views/HistoryView'

type Tab = 'draft' | 'audit' | 'history'

const TABS: { id: Tab; label: string }[] = [
  { id: 'draft', label: 'Draft' },
  { id: 'audit', label: 'Audit' },
  { id: 'history', label: 'History' },
]

const DEVICE_LABEL: Record<DeviceState, string> = {
  checking: 'Checking for an on-device model…',
  unsupported: 'No on-device model · sealed',
  downloadable: 'On-device model not downloaded',
  downloading: 'Downloading on-device model…',
  ready: 'Gemini Nano ready on this device',
}

function DeviceStatus({ state, progress, onDownload }: { state: DeviceState; progress: number | null; onDownload: () => void }) {
  const dot = state === 'ready' ? 'ok' : state === 'checking' ? '' : 'warn'
  return (
    <div className="status">
      <span className={`dot ${dot}`} />
      {state === 'downloading' && progress !== null ? `Downloading on-device model · ${Math.round(progress * 100)}%` : DEVICE_LABEL[state]}
      {state === 'downloadable' && (
        <button type="button" className="btn small" onClick={onDownload}>
          Download
        </button>
      )}
    </div>
  )
}

export default function App() {
  const [tab, setTab] = useState<Tab>('draft')
  const [device, setDevice] = useState<DeviceState>('checking')
  const [progress, setProgress] = useState<number | null>(null)
  const [policy, setPolicy] = useState<Policy>(DEFAULT_POLICY)

  useEffect(() => {
    deviceState()
      .then((state) => {
        setDevice(state)
        if (state === 'ready') preloadDevice()
      })
      .catch(() => setDevice('unsupported'))
    policyReady.then(setPolicy)
  }, [])

  // A download started in another tab or before a reload finishes on its own; watch for it.
  useEffect(() => {
    if (device !== 'downloading') return
    const timer = setInterval(() => {
      deviceState()
        .then((state) => {
          setDevice((d) => (d === 'downloading' && state !== 'downloading' ? state : d))
          if (state === 'ready') preloadDevice()
        })
        .catch(() => undefined)
    }, 3000)
    return () => clearInterval(timer)
  }, [device])

  const download = () => {
    setDevice('downloading')
    warmDevice(setProgress)
      .then(deviceState)
      .then(setDevice)
      .catch(() => deviceState().then(setDevice, () => setDevice('unsupported')))
  }

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Airlock
          <span className="brand-sub">Cloud-quality letters. The cloud never sees who.</span>
        </div>
        <nav className="tabs" aria-label="Sections">
          {TABS.map((t) => (
            <button key={t.id} type="button" className="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <span className="badge">POLICY · {policy.policyName}</span>
        <DeviceStatus state={device} progress={progress} onDownload={download} />
      </header>
      <main>
        {/* Views stay mounted so a draft in progress survives a tab switch. */}
        <div hidden={tab !== 'draft'}>
          <DraftView device={device} policy={policy} />
        </div>
        <div hidden={tab !== 'audit'}>
          <AuditView device={device} />
        </div>
        {tab === 'history' && <HistoryView />}
      </main>
    </div>
  )
}
