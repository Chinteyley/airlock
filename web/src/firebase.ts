import { initializeApp } from 'firebase/app'
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check'
import { getAuth, signInAnonymously } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'
import { fetchAndActivate, getRemoteConfig, getValue } from 'firebase/remote-config'

// Public web config: these values identify the project, they are not secrets.
const firebaseConfig = {
  apiKey: 'AIzaSyDwzeLTGNPDC04q8wDSQxfXyWWZxgCU0ns',
  authDomain: 'airlock-hybrid-2026.firebaseapp.com',
  projectId: 'airlock-hybrid-2026',
  storageBucket: 'airlock-hybrid-2026.firebasestorage.app',
  messagingSenderId: '715775426095',
  appId: '1:715775426095:web:271a71534c353fd52c90da',
}

const RECAPTCHA_SITE_KEY = '6LdPgTMuAAAAANlymLT0s1NgKfMy0go-7e-x2uIq'

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

export const authReady = signInAnonymously(auth).then((c) => c.user)

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

export const policyReady: Promise<Policy> = fetchAndActivate(remoteConfig)
  .catch(() => false)
  .then(() => ({
    policyName: getValue(remoteConfig, 'policy_name').asString(),
    draftModel: getValue(remoteConfig, 'draft_model').asString(),
    draftInstructions: getValue(remoteConfig, 'draft_instructions').asString(),
  }))
