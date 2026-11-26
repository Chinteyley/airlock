// The two jobs Airlock gives the models on iOS, each with its own rule:
// - finding identifiers runs only on Apple's on-device model; if it isn't
//   available, Airlock stays sealed and never sends the raw note instead;
// - drafting prefers Gemini through Firebase AI Logic (GeminiLanguageModel, a
//   Foundation Models LanguageModel) and falls back to the on-device model
//   when the cloud can't be reached. It only ever sees the redacted note.

import FirebaseAILogic
import Foundation
import FoundationModels

enum DraftSource: String, Sendable {
  case inCloud = "IN_CLOUD"
  case onDevice = "ON_DEVICE"
}

struct Draft: Sendable {
  var text: String
  var source: DraftSource
  var ms: Int
  var cloudError: String?
}

private let draftPreamble =
  "The note has been de-identified on the clinician's device. Bracketed tokens such as [PATIENT_1], [CLINICIAN_2] or [DATE_3] stand for real values you will never see. Use the tokens verbatim wherever the value belongs, exactly as written, brackets included. Never invent names, dates, places, numbers or contact details, and never try to guess what a token stands for."

func buildDraftPrompt(redactedNote: String, task: String, instructions: String) -> String {
  """
  \(instructions)

  \(draftPreamble)

  Task: \(task)

  De-identified note:
  \"\"\"
  \(redactedNote)
  \"\"\"
  """
}

func draftLetter(prompt: String, model: String) async -> Result<Draft, Error> {
  let start = Date()
  let elapsed = { Int(Date().timeIntervalSince(start) * 1000) }
  do {
    let cloud = FirebaseAI.firebaseAI(backend: .googleAI()).geminiLanguageModel(name: model)
    let response = try await LanguageModelSession(model: cloud).respond(to: prompt)
    return .success(Draft(text: response.content, source: .inCloud, ms: elapsed()))
  } catch {
    let cloudError = error.localizedDescription
    guard deviceState() == .ready else { return .failure(error) }
    do {
      let response = try await LanguageModelSession(model: deviceModel).respond(to: prompt)
      return .success(Draft(text: response.content, source: .onDevice, ms: elapsed(), cloudError: cloudError))
    } catch {
      return .failure(error)
    }
  }
}

/// What patterns alone hold, everywhere each found value appears.
func patternSpans(_ note: String) -> [Span] {
  mergeSpans(expandSpans(note, findPatterns(note)), in: note)
}

/// Names, numbers and places typed into the task line that the note scan never saw.
func unheldInTask(_ sealedTask: String) async -> [String] {
  let plain = tokenRegex.stringByReplacingMatches(
    in: sealedTask, range: NSRange(location: 0, length: (sealedTask as NSString).length), withTemplate: " ")
  var found = findPatterns(plain).map(\.text)
  if deviceState() == .ready, let entities = try? await detectOnDevice(plain) {
    // Services and programs ("a PTSD clinic") are what a task names; people and places aren't.
    let kinds: Set<String> = ["patient", "relative", "clinician", "person", "place"]
    found += entities.filter { kinds.contains($0.kind) }.map { $0.text.trimmingCharacters(in: .whitespaces) }
      // A name has a capital somewhere; "orthopedic surgeon" is a role, not a name.
      .filter { t in t.count > 1 && t.contains(where: \.isUppercase) && plain.lowercased().contains(t.lowercased()) }
  }
  return Array(Set(found))
}

struct Scan {
  var spans: [Span]
  var onDevice: Bool
  var ms: Int
}

/// Patterns always run; the on-device model runs only when it is ready.
func scan(_ note: String) async throws -> Scan {
  let start = Date()
  let pattern = findPatterns(note)
  guard deviceState() == .ready else {
    return Scan(spans: patternSpans(note), onDevice: false, ms: 0)
  }
  let entities = try await detectOnDevice(note)
  let spans = mergeSpans(expandSpans(note, pattern + spansFromEntities(note, entities)), in: note)
  return Scan(spans: spans, onDevice: true, ms: Int(Date().timeIntervalSince(start) * 1000))
}
