// Runs the fixture notes through the iOS app's own on-device detector
// (OnDevice.swift, Detect.swift, Vault.swift) on a Mac with Apple Intelligence,
// and counts labeled identifiers that would still reach the cloud.
//
//   cd ios && swiftc -o build/audit Audit/main.swift Airlock/OnDevice.swift Airlock/Detect.swift Airlock/Vault.swift
//   build/audit ../fixtures/notes.json

import Foundation

struct Note: Decodable {
  struct Identifier: Decodable { var text: String }
  var id: String
  var split: String
  var text: String
  var identifiers: [Identifier]
}
struct File: Decodable { var notes: [Note] }

let path = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "../fixtures/notes.json"
let notes = try JSONDecoder().decode(File.self, from: Data(contentsOf: URL(fileURLWithPath: path))).notes
print("on-device model:", deviceState())

var total = 0, leaked = 0, patternLeaked = 0, ms = 0
for n in notes {
  let start = Date()
  let entities = try await detectOnDevice(n.text)
  let elapsed = Int(Date().timeIntervalSince(start) * 1000)
  ms += elapsed
  let truth = n.identifiers.map(\.text)
  let spans = mergeSpans(expandSpans(n.text, findPatterns(n.text) + spansFromEntities(n.text, entities)), in: n.text)
  let leaks = findLeaks(redact(n.text, spans: spans).redacted, values: truth)
  let patternOnly = redact(n.text, spans: mergeSpans(expandSpans(n.text, findPatterns(n.text)), in: n.text)).redacted
  let pLeaks = findLeaks(patternOnly, values: truth)
  total += truth.count
  leaked += leaks.count
  patternLeaked += pLeaks.count
  print("\(n.id) [\(n.split)] leaked \(leaks.count)/\(truth.count) \(leaks) · patterns alone \(pLeaks.count) · \(elapsed) ms")
}
print("TOTAL leaked \(leaked)/\(total) · patterns alone \(patternLeaked)/\(total) · mean \(ms / max(notes.count, 1)) ms")
