# Airlock

**Cloud-quality referral letters. The cloud never sees who.**

Clinicians, therapists and social workers spend hours turning session notes into referral letters. A cloud model writes those letters well, but pasting a client's note into one sends their name, birth date, address and diagnosis to a server the clinic doesn't control. A small on-device model keeps the note private, but it can't write the letter as well.

Airlock uses both, for the job each one is good at:

1. **The on-device model finds every identifier.** Gemini Nano in Chrome reads the raw note and lists every person, relative, clinician, facility and place. Pattern detectors catch phones, emails, record numbers and dates. Nothing in this step can reach the cloud.
2. **The clinician reviews.** Held identifiers are highlighted; click one to release it, select text to hold something the scan missed.
3. **Only tokens leave.** Each identifier becomes a typed token (`[PATIENT_1]`, `[CLINICIAN_1]`, `[DOB_1] (age 54)`), and the cloud model drafts the letter from that redacted note.
4. **Airlock proves it.** Before sending, the full prompt is checked for every held value (and any name typed into the task line), and Send stays locked until the count is zero. After sending, the app captures the literal body of the request where the Firebase SDK calls `fetch` and checks it again. The wire panel shows that body, its HTTP status and the count: *0 of 17 held*.
5. **Names come back on the device.** Tokens are swapped back for real values locally, by plain string substitution, not by a model.

Try it: **https://airlock-hybrid-2026.web.app** (Chrome on desktop; see [Testing](#testing)).

## How Airlock uses Firebase AI Logic hybrid inference

Airlock uses three inference modes, and each choice is a privacy decision, not a fallback setting.

| Job | Mode | Why |
| --- | --- | --- |
| Find identifiers in the raw note | `ONLY_ON_DEVICE`, JSON-constrained output | The raw note must never be a cloud request. If no on-device model is ready, this step fails and Airlock **stays sealed**: patterns plus a mandatory manual review stand in, and the raw note is never sent instead. The response's `inferenceSource` is checked, and detection refuses any result that didn't run on the device. |
| Draft the letter from the redacted note | `PREFER_IN_CLOUD` (model from Remote Config) | Letters are better from a cloud model, and the input holds only tokens. When the cloud request fails (offline, overloaded, a bad model name), the SDK drafts on-device instead; the wire panel shows the attempted request with its status. |
| Audit detection on labeled notes | `ONLY_ON_DEVICE` | Measures, on the user's own machine, how many labeled identifiers would still reach the cloud. |

Code: [`web/src/ai.ts`](web/src/ai.ts) (models), [`web/src/lib/detect.ts`](web/src/lib/detect.ts) (patterns and span merging), [`web/src/lib/vault.ts`](web/src/lib/vault.ts) (tokens, restore, leak scan), [`web/src/lib/wire.ts`](web/src/lib/wire.ts) (request capture).

## Firebase products

- **Firebase AI Logic** (Gemini Developer API) with hybrid inference on Chrome's Prompt API (Gemini Nano).
- **App Check**, enforced for AI Logic: Fraud Defense (reCAPTCHA Enterprise) on the hosted app, the debug provider in local development.
- **Authentication**: anonymous sign-in scopes each user's history.
- **Cloud Firestore**: stores the redacted note and the letter as the cloud wrote it, tokens and all: the same text that already went to the cloud, nothing more. Before writing, the app scans the record for every held value and refuses to store it if one is found (a client-side guard). Security rules enforce ownership, the schema and field sizes, and reject any record that reports a leaked value.
- **Remote Config**: the policy name, the cloud drafting model and the drafting instructions, so an organization can change them without a release.
- **Hosting**: https://airlock-hybrid-2026.web.app.

## Measured

The Audit tab runs every note in [`fixtures/notes.json`](fixtures/notes.json) through the on-device scan and checks the text that would go to the cloud for each labeled identifier. On an M3 Pro MacBook Pro with Chrome 158 (Gemini Nano), Nov 26, 2026, three runs between 10:50 and 11:40 PM local (the last on the final code):

| Notes | Labeled identifiers | Leaked with Airlock (3 runs) | Leaked with patterns alone |
| --- | --- | --- | --- |
| 10 tuning notes | 128 | 0, 0, 0 | 40 |
| 5 held-out notes | 65 | 0, 0, 0 | 37 |

Mean on-device scan time: 7.9–8.4 s per note (two Nano passes: everything named, then places and organizations alone).

The model's output varies between runs. An earlier single-pass version missed 1 to 3 identifiers on some runs (a city mentioned on its own, a name in a signature), which is why the second pass and the signature and relation backstops exist. The tuning notes were used while writing the prompts and pattern backstops; the held-out notes were written afterwards. They were not used for tuning, with one exception: a code review pointed out that "Chart number 00-4417-82" in a held-out note had no matching pattern label, so labels for chart, case, file and claim numbers were added. All notes are synthetic: every person, place and number in them is invented. A small model can still miss an identifier in a note unlike these, which is why the review step exists and why the wire panel checks the real request.

## Run it locally

Requirements: [Bun](https://bun.sh), the Firebase CLI, and Chrome 139+ on desktop with the on-device model (see Testing).

```sh
cd web
bun install
# Register an App Check debug token for local development:
firebase appcheck:debugtokens:create --app <your web app id>
echo "VITE_APPCHECK_DEBUG_TOKEN=<that token>" > .env.development.local
bun run dev        # http://localhost:5180
bun test           # vault, patterns and leak-scan tests
```

The config in [`web/src/firebase.ts`](web/src/firebase.ts) is Firebase's public app identifier, not a secret: App Check and security rules protect the backend. To use your own Firebase project, replace it, enable AI Logic with the Gemini Developer API, register the web app with App Check, enable anonymous Auth, then `firebase deploy --only firestore:rules,remoteconfig,hosting`.

## Testing

1. Open https://airlock-hybrid-2026.web.app in Chrome on a desktop (Windows, macOS, Linux or ChromeOS) that meets Chrome's [on-device model requirements](https://developer.chrome.com/docs/ai/get-started). If the status pill says the model isn't downloaded, click **Download** and wait.
2. On **Draft**, pick a sample note, click **Scan on this device**, review the highlights, then **Send through the airlock**. The middle column shows the captured request and how many held values it contains.
3. **Audit** runs the labeled notes on your machine. **History** shows what Firestore stored.
4. On a browser with no on-device model, the scan stays sealed: patterns hold what they can, and sending requires a manual review.

## Limits

- On Chrome, on-device inference needs a desktop that meets Chrome's hardware requirements. Without it, Airlock still never sends a raw note, but detection falls to patterns and manual review.
- Redaction removes direct identifiers. A rare diagnosis or a distinctive story can still identify someone, and the clinician remains responsible for what they send.
- History is per anonymous session on each device.

## License

[Apache 2.0](LICENSE)
