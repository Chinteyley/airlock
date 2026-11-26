// Finding identifiers with Apple's on-device model (Foundation Models only, no
// Firebase), so the app and the command-line audit in ios/Audit run the same code.

import Foundation
import FoundationModels

@Generable
enum EntityKind: String {
  case patient, relative, clinician, person, organization, place
}

@Generable
struct DetectedEntity {
  @Guide(description: "The span exactly as written in the note")
  var text: String
  var kind: EntityKind
}

@Generable
struct DetectedEntities {
  @Guide(description: "Every person, organization and place named in the note")
  var entities: [DetectedEntity]
}

@Generable
struct DetectedPlaces {
  @Guide(description: "Every place and organization name in the note, copied exactly")
  var places: [String]
}

enum DeviceState: Equatable {
  case ready
  case unavailable(String)
}

// Clinical notes describe self-harm, overdoses and abuse; extraction must not
// be blocked by guardrails meant for open-ended generation.
let deviceModel = SystemLanguageModel(guardrails: .permissiveContentTransformations)

func deviceState() -> DeviceState {
  switch deviceModel.availability {
  case .available: return .ready
  case .unavailable(let reason): return .unavailable(String(describing: reason))
  }
}

private let detectInstructions = """
  You are a de-identification tool for clinical notes. List every span that names a specific person, organization or place:
  - patient: the patient's names, surnames and nicknames
  - relative: family members, partners, friends, roommates
  - clinician: doctors, nurses, therapists, counselors, teachers, officers, case managers, any staff
  - person: any other named person
  - organization: hospitals, clinics, schools, employers, stores, banks, clubs, agencies, programs
  - place: every city, town, county, state road, street, neighborhood or landmark, including a city mentioned on its own (for example "lives in Reno")
  Copy each span exactly as written. Do not list medications, diagnoses, job titles, or generic words like "mother" or "the clinic".
  """

private let placeInstructions = """
  List the name of every city, town, county, state, road, street, neighborhood, landmark, hospital, clinic, school, store, business, bank, club, agency and program in the clinical note, copied exactly as written. Include a city even when it is mentioned on its own, like "in Reno" or "in Madison".
  """

/// Two on-device passes: everyone and everything named, then places and
/// organizations alone, which the first pass tends to skip. Measured on the
/// fixture notes, the second pass took leaks from 5 of 193 to 0.
func detectOnDevice(_ note: String) async throws -> [ModelEntity] {
  guard deviceState() == .ready else { throw AirlockError.sealed }
  let prompt = "Note:\n\"\"\"\n\(note)\n\"\"\""
  var entities: [ModelEntity]
  do {
    let r = try await LanguageModelSession(model: deviceModel, instructions: detectInstructions)
      .respond(to: prompt, generating: DetectedEntities.self)
    entities = r.content.entities.map { ModelEntity(text: $0.text, kind: $0.kind.rawValue) }
  } catch LanguageModelSession.GenerationError.guardrailViolation {
    // The permissive guardrail covers plain-text output only, so retry as lines.
    let r = try await LanguageModelSession(
      model: deviceModel,
      instructions: detectInstructions + "\nAnswer with one line per span, formatted as kind|span, and nothing else."
    ).respond(to: prompt)
    entities = parseEntityLines(r.content)
  }
  if let r = try? await LanguageModelSession(model: deviceModel, instructions: placeInstructions)
    .respond(to: prompt, generating: DetectedPlaces.self)
  {
    entities += r.content.places.map { ModelEntity(text: $0, kind: "place") }
  }
  return entities
}

/// The model writes "kind|span", sometimes "span|kind", sometimes with trailing commas.
func parseEntityLines(_ out: String) -> [ModelEntity] {
  let kinds: Set<String> = ["patient", "relative", "clinician", "person", "organization", "place"]
  let trim = CharacterSet.whitespaces.union(CharacterSet(charactersIn: "-*•,;`"))
  return out.split(whereSeparator: \.isNewline).compactMap { line in
    let parts = line.split(separator: "|", maxSplits: 1).map { $0.trimmingCharacters(in: trim) }
    guard parts.count == 2 else { return nil }
    if kinds.contains(parts[0].lowercased()), !parts[1].isEmpty {
      return ModelEntity(text: parts[1], kind: parts[0].lowercased())
    }
    if kinds.contains(parts[1].lowercased()), !parts[0].isEmpty {
      return ModelEntity(text: parts[0], kind: parts[1].lowercased())
    }
    return nil
  }
}

enum AirlockError: LocalizedError {
  case sealed
  var errorDescription: String? { "No on-device model is ready; the note stays on this device." }
}
