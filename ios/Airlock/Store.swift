// Firebase around the models: App Check, anonymous Auth, Remote Config policy,
// Firestore history of redacted drafts, and the shared fixture notes.

import FirebaseAppCheck
import FirebaseAuth
import FirebaseCore
import FirebaseFirestore
import FirebaseRemoteConfig
import Foundation

enum Firebase {
  static func configure() {
    #if DEBUG
      // Local builds attest with a registered debug token from Secrets.xcconfig.
      if let token = Bundle.main.object(forInfoDictionaryKey: "AppCheckDebugToken") as? String, !token.isEmpty {
        UserDefaults.standard.set(token, forKey: "GACAppCheckDebugToken")
      }
      AppCheck.setAppCheckProviderFactory(AppCheckDebugProviderFactory())
    #else
      AppCheck.setAppCheckProviderFactory(AppAttestProviderFactory())
    #endif
    FirebaseApp.configure()
  }
}

final class AppAttestProviderFactory: NSObject, AppCheckProviderFactory {
  func createProvider(with app: FirebaseApp) -> (any AppCheckProvider)? {
    AppAttestProvider(app: app)
  }
}

struct Policy: Sendable {
  var policyName = "HIPAA Safe Harbor"
  var draftModel = "gemini-3.5-flash-lite"
  var draftInstructions =
    "Write a concise, professional referral letter from the note author to the receiving service. Include the reason for referral, relevant history, current treatment, risks, and the specific ask. Plain text, no markdown."
}

func loadPolicy() async -> Policy {
  let rc = RemoteConfig.remoteConfig()
  let settings = RemoteConfigSettings()
  settings.minimumFetchInterval = 60
  rc.configSettings = settings
  let defaults = Policy()
  rc.setDefaults([
    "policy_name": defaults.policyName as NSString,
    "draft_model": defaults.draftModel as NSString,
    "draft_instructions": defaults.draftInstructions as NSString,
  ])
  _ = try? await rc.fetchAndActivate()
  return Policy(
    policyName: rc["policy_name"].stringValue,
    draftModel: rc["draft_model"].stringValue,
    draftInstructions: rc["draft_instructions"].stringValue
  )
}

struct StoredDraft: Identifiable {
  var id: String
  var title: String
  var platform: String
  var redactedLetter: String
  var held: Int
  var leaked: Int
  var draftedOn: String
  var createdAt: Date?
}

enum History {
  static func uid() async throws -> String {
    if let user = Auth.auth().currentUser { return user.uid }
    return try await Auth.auth().signInAnonymously().user.uid
  }

  /// Refuses to store a record that contains any held value.
  static func save(
    title: String, redactedNote: String, redactedLetter: String, held: Int, leaked: Int,
    detectedOn: String, draftedOn: DraftSource, heldValues: [String]
  ) async throws {
    let leaks = findLeaks([title, redactedNote, redactedLetter].joined(separator: "\n"), values: heldValues)
    guard leaks.isEmpty else { throw HistoryError.refused(leaks.count) }
    let uid = try await uid()
    _ = try await Firestore.firestore().collection("users").document(uid).collection("drafts").addDocument(data: [
      "title": title, "platform": "ios", "redactedNote": redactedNote, "redactedLetter": redactedLetter,
      "held": held, "leaked": leaked, "detectedOn": detectedOn, "draftedOn": draftedOn.rawValue,
      "payloadSha256": NSNull(), "createdAt": FieldValue.serverTimestamp(),
    ])
  }

  static func list() async throws -> [StoredDraft] {
    let uid = try await uid()
    let snap = try await Firestore.firestore().collection("users").document(uid).collection("drafts")
      .order(by: "createdAt", descending: true).limit(to: 25).getDocuments()
    return snap.documents.map { d in
      let x = d.data()
      return StoredDraft(
        id: d.documentID, title: x["title"] as? String ?? "", platform: x["platform"] as? String ?? "",
        redactedLetter: x["redactedLetter"] as? String ?? "", held: x["held"] as? Int ?? 0,
        leaked: x["leaked"] as? Int ?? 0, draftedOn: x["draftedOn"] as? String ?? "",
        createdAt: (x["createdAt"] as? Timestamp)?.dateValue())
    }
  }
}

enum HistoryError: LocalizedError {
  case refused(Int)
  var errorDescription: String? {
    if case .refused(let n) = self { return "Refusing to store: \(n) held values found in the record." }
    return nil
  }
}

struct Fixture: Decodable, Identifiable, Hashable {
  struct Identifier: Decodable, Hashable {
    var text: String
    var kind: String
  }
  var id: String
  var title: String
  var task: String
  var text: String
  var split: String
  var identifiers: [Identifier]
}

let fixtures: [Fixture] = {
  struct File: Decodable { var notes: [Fixture] }
  guard let url = Bundle.main.url(forResource: "notes", withExtension: "json"),
    let data = try? Data(contentsOf: url),
    let file = try? JSONDecoder().decode(File.self, from: data)
  else { return [] }
  return file.notes
}()
