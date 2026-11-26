// The two jobs Airlock gives Firebase AI Logic, each with its own inference mode:
// - finding identifiers runs ONLY_ON_DEVICE: the raw note must never be a
//   cloud request, so if no local model is ready this fails and Airlock stays
//   sealed rather than falling back;
// - drafting the letter runs PREFER_IN_CLOUD on redacted text only, and
//   falls back to the on-device model when the cloud can't be reached.

import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, InferenceSource } from 'firebase/ai'
import type { GenerativeModel } from 'firebase/ai'
import type { ModelEntity } from './lib/detect'
import { app } from './firebase'

const ai = getAI(app, { backend: new GoogleAIBackend() })

const ENTITY_KINDS = ['patient', 'relative', 'clinician', 'person', 'organization', 'place']

// JSON Schema for Chrome's Prompt API responseConstraint.
const entitySchema = {
  type: 'object',
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          kind: { type: 'string', enum: ENTITY_KINDS },
        },
        required: ['text', 'kind'],
      },
    },
  },
  required: ['entities'],
}

const EN = [{ type: 'text' as const, languages: ['en'] }]

export const detector = getGenerativeModel(ai, {
  mode: InferenceMode.ONLY_ON_DEVICE,
  onDeviceParams: {
    createOptions: { expectedInputs: EN, expectedOutputs: EN },
    promptOptions: { responseConstraint: entitySchema },
  },
})

const DETECT_PROMPT = `You are a de-identification tool for clinical notes.
List every span in the note that names a specific person, organization or place:
- patient: the patient's names, surnames and nicknames
- relative: family members, partners, friends, roommates
- clinician: doctors, nurses, therapists, counselors, teachers, officers, case managers, any staff
- person: any other named person
- organization: hospitals, clinics, schools, employers, stores, banks, clubs, agencies, programs
- place: cities, towns, counties, streets, neighborhoods, landmarks
Copy each span exactly as written in the note. Do not list medications, diagnoses, job titles, or generic words like "mother" or "the clinic".

Note:
"""
{NOTE}
"""`

export type DeviceState = 'checking' | 'unsupported' | 'downloadable' | 'downloading' | 'ready'

// Chrome's Prompt API reports availability before any session exists.
export async function deviceState(): Promise<DeviceState> {
  const lm = (globalThis as { LanguageModel?: LanguageModelApi }).LanguageModel
  if (!lm) return 'unsupported'
  const a = await lm.availability({ expectedInputs: EN, expectedOutputs: EN })
  if (a === 'available') return 'ready'
  if (a === 'downloading') return 'downloading'
  if (a === 'downloadable') return 'downloadable'
  return 'unsupported'
}

interface LanguageModelApi {
  availability(o?: object): Promise<string>
  create(o?: object): Promise<object>
}

let warmSession: Promise<object> | null = null

// Loading Nano into memory takes several seconds on the first session of a
// page; holding one idle session keeps it loaded so the first scan is quick.
export function preloadDevice() {
  const lm = (globalThis as { LanguageModel?: LanguageModelApi }).LanguageModel
  if (lm && !warmSession) warmSession = lm.create({ expectedInputs: EN, expectedOutputs: EN }).catch(() => ({}))
}

// Must run on a user gesture: Chrome only starts a model download from one.
export function warmDevice(onProgress: (fraction: number) => void): Promise<void> {
  return detector.initializeDeviceModel(onProgress)
}

function isEntity(x: unknown): x is ModelEntity {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as ModelEntity).text === 'string' &&
    typeof (x as ModelEntity).kind === 'string'
  )
}

// The SDK keeps one on-device session and destroys it when the next request
// starts, so on-device requests run one at a time.
let queue: Promise<unknown> = Promise.resolve()
function oneAtATime<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job)
  queue = run.catch(() => undefined)
  return run
}

// `places: false` skips the second pass (the task line names services, not places).
export function detectOnDevice(note: string, { places = true } = {}): Promise<ModelEntity[]> {
  return oneAtATime(() => detect(note, places))
}

const PLACES_PROMPT = `List the name of every city, town, county, state, road, street, neighborhood, landmark, hospital, clinic, school, store, business, bank, club, agency and program in the clinical note, copied exactly as written. Include a city even when it is mentioned on its own.

Note:
"""
{NOTE}
"""`

const placesSchema = {
  type: 'object',
  properties: { places: { type: 'array', items: { type: 'string' } } },
  required: ['places'],
}

const placeDetector = getGenerativeModel(ai, {
  mode: InferenceMode.ONLY_ON_DEVICE,
  onDeviceParams: {
    createOptions: { expectedInputs: EN, expectedOutputs: EN },
    promptOptions: { responseConstraint: placesSchema },
  },
})

// A second pass for places and organizations alone, which the first pass
// sometimes skips ("her mom in Madison"). Its failure never fails the scan.
async function detectPlaces(note: string): Promise<ModelEntity[]> {
  try {
    const result = await placeDetector.generateContent(PLACES_PROMPT.replace('{NOTE}', () => note))
    if (result.response.inferenceSource !== InferenceSource.ON_DEVICE) return []
    const parsed: unknown = JSON.parse(result.response.text())
    const list = (parsed as { places?: unknown }).places
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string').map((text) => ({ text, kind: 'place' })) : []
  } catch {
    return []
  }
}

async function detect(note: string, places: boolean): Promise<ModelEntity[]> {
  // ONLY_ON_DEVICE alone isn't enough: without Chrome's Prompt API the SDK has
  // no on-device adapter, so check the model is ready before handing it a note.
  if ((await deviceState()) !== 'ready') throw new Error('No on-device model is ready; the note stays on this device.')
  const result = await detector.generateContent(DETECT_PROMPT.replace('{NOTE}', () => note))
  if (result.response.inferenceSource !== InferenceSource.ON_DEVICE) {
    throw new Error('Detection did not run on this device; refusing to continue.')
  }
  const parsed: unknown = JSON.parse(result.response.text())
  const list = (parsed as { entities?: unknown }).entities
  const entities = Array.isArray(list) ? list.filter(isEntity) : []
  return places ? [...entities, ...(await detectPlaces(note))] : entities
}

const drafters = new Map<string, GenerativeModel>()

function drafter(model: string): GenerativeModel {
  let m = drafters.get(model)
  if (!m) {
    m = getGenerativeModel(ai, {
      mode: InferenceMode.PREFER_IN_CLOUD,
      inCloudParams: { model, generationConfig: { temperature: 0.3 } },
      onDeviceParams: { createOptions: { expectedInputs: EN, expectedOutputs: EN } },
    })
    drafters.set(model, m)
  }
  return m
}

export interface Draft {
  text: string
  source: 'ON_DEVICE' | 'IN_CLOUD'
  ms: number
}

// The whole prompt is built here, before anything is sent, so the app can
// show it and check it for held values first.
const PREAMBLE =
  "The note has been de-identified on the clinician's device. Bracketed tokens such as [PATIENT_1], [CLINICIAN_2] or [DATE_3] stand for real values you will never see. Use the tokens verbatim wherever the value belongs, exactly as written, brackets included. Never invent names, dates, places, numbers or contact details, and never try to guess what a token stands for."

export function buildDraftPrompt(redactedNote: string, task: string, instructions: string): string {
  return `${instructions}

${PREAMBLE}

Task: ${task}

De-identified note:
"""
${redactedNote}
"""`
}

export async function draftLetter(prompt: string, model: string): Promise<Draft> {
  const t0 = performance.now()
  const result = await drafter(model).generateContent(prompt)
  return {
    text: result.response.text().trim(),
    source: result.response.inferenceSource === InferenceSource.ON_DEVICE ? 'ON_DEVICE' : 'IN_CLOUD',
    ms: Math.round(performance.now() - t0),
  }
}

// The text of a captured request body without Airlock's own fixed template,
// which is what the leak scan should read.
export function userTextOf(body: string): string {
  let text = body
  try {
    // Every string in the body, wherever the SDK put it.
    const all: string[] = []
    const walk = (v: unknown) => {
      if (typeof v === 'string') all.push(v)
      else if (Array.isArray(v)) for (const x of v) walk(x)
      else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x)
    }
    walk(JSON.parse(body))
    text = all.join('\n')
  } catch {
    // Not JSON: scan the raw body.
  }
  // Only Airlock's own template is skipped; Remote Config instructions are scanned too.
  return text.replace(PREAMBLE, '').replace('De-identified note:', '').replace('Task:', '')
}
