import { initializeApp } from 'firebase/app'
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check'
import type { User } from 'firebase/auth'
import { getAuth, signInAnonymously } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'
import { fetchAndActivate, getRemoteConfig, getValue } from 'firebase/remote-config'

// Public web config: these values identify the project, they are not secrets.
const firebaseConfig = {
  apiKey: 'AIzaSyB8T4G6frizweaXlcU1U0KF8DYk5QlGl1c',
  authDomain: 'fb-ailogic26vrt-3303.firebaseapp.com',
  projectId: 'fb-ailogic26vrt-3303',
  storageBucket: 'fb-ailogic26vrt-3303.firebasestorage.app',
  messagingSenderId: '1040733446367',
  appId: '1:1040733446367:web:d894b3517abb5ee880496a',
}

const RECAPTCHA_SITE_KEY = '6LeFhTQuAAAAAK_ia3Af2ffGUO2Gr03DyvqwbL_4'

export const app = initializeApp(firebaseConfig)

// Local development uses a registered App Check debug token from .env.local;
// the hosted app attests with Fraud Defense (reCAPTCHA Enterprise).
const debugToken = import.meta.env.VITE_APPCHECK_DEBUG_TOKEN
if (debugToken) {
  ;(self as { FIREBASE_APPCHECK_DEBUG_TOKEN?: string }).FIREBASE_APPCHECK_DEBUG_TOKEN = debugToken
}
initializeAppCheck(app, {
  provider: new ReCaptchaEnterpriseProvider(RECAPTCHA_SITE_KEY),
  isTokenAutoRefreshEnabled: true,
})

export const auth = getAuth(app)
export const db = getFirestore(app)

// Signs in anonymously on first use, and tries again after a failure (an
// offline start shouldn't break history for the rest of the session).
let signIn: Promise<User> | null = null
export function ensureAuth(): Promise<User> {
  if (auth.currentUser) return Promise.resolve(auth.currentUser)
  signIn ??= signInAnonymously(auth)
    .then((c) => c.user)
    .catch((e: unknown) => {
      signIn = null
      throw e
    })
  return signIn
}

const remoteConfig = getRemoteConfig(app)
remoteConfig.settings.minimumFetchIntervalMillis = 60_000

// Policy lives in Remote Config so an organization can change it without a release.
export const POLICY_DEFAULTS = {
  policy_name: 'HIPAA Safe Harbor',
  draft_model: 'gemini-3.5-flash-lite',
  draft_instructions:
    'Write a concise, professional referral letter from the note author to the receiving service. Include the reason for referral, relevant history, current treatment, risks, and the specific ask. Plain text, no markdown.',
}
remoteConfig.defaultConfig = POLICY_DEFAULTS

export interface Policy {
  policyName: string
  draftModel: string
  draftInstructions: string
}

export const DEFAULT_POLICY: Policy = {
  policyName: POLICY_DEFAULTS.policy_name,
  draftModel: POLICY_DEFAULTS.draft_model,
  draftInstructions: POLICY_DEFAULTS.draft_instructions,
}

export const policyReady: Promise<Policy> = fetchAndActivate(remoteConfig)
  .catch(() => false)
  .then(() => ({
    policyName: getValue(remoteConfig, 'policy_name').asString(),
    draftModel: getValue(remoteConfig, 'draft_model').asString(),
    draftInstructions: getValue(remoteConfig, 'draft_instructions').asString(),
  }))
