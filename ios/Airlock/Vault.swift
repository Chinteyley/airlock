// Swaps held identifiers for typed tokens before anything leaves the device,
// and back afterwards. A port of web/src/lib/vault.ts: plain string work, so
// restoring never depends on a model.

import Foundation

struct VaultEntry: Hashable, Sendable {
  var token: String
  var value: String
  var kind: Kind
}

struct Redaction: Sendable {
  var redacted: String
  var entries: [VaultEntry]
  /// Every held string (full values and name parts) and its token.
  var lookup: [(String, String)]
}

private let tokenLabel: [Kind: String] = [
  .patient: "PATIENT", .relative: "RELATIVE", .clinician: "CLINICIAN", .person: "PERSON",
  .organization: "ORG", .address: "PLACE", .date: "DATE", .dob: "DOB", .phone: "PHONE",
  .email: "EMAIL", .record: "ID", .url: "URL",
]

let tokenRegex = try! NSRegularExpression(pattern: #"\[([A-Z]+)_(\d+)\]"#)

/// Safe Harbor allows an age, not a birth date; ages over 89 are grouped.
func ageLabel(_ dob: String, today: Date = .now) -> String? {
  let parts = dob.split(separator: "/").compactMap { Int($0) }
  guard parts.count == 3 else { return nil }
  let thisYear = Calendar.current.component(.year, from: today) % 100
  let year = parts[2] < 100 ? (parts[2] <= thisYear ? 2000 : 1900) + parts[2] : parts[2]
  guard let born = Calendar.current.date(from: DateComponents(year: year, month: parts[0], day: parts[1])),
    let age = Calendar.current.dateComponents([.year], from: born, to: today).year, age >= 0
  else { return nil }
  return age > 89 ? "age 90+" : "age \(age)"
}

/// "Maria Delgado", "MARIA DELGADO" and a line-wrapped "Maria\nDelgado" are one value.
private func key(_ value: String) -> String {
  value.lowercased().split(whereSeparator: \.isWhitespace).joined(separator: " ")
}

func redact(_ text: String, spans: [Span], today: Date = .now) -> Redaction {
  var byValue: [String: VaultEntry] = [:]
  var counters: [String: Int] = [:]
  var entries: [VaultEntry] = []

  func issue(_ value: String, _ kind: Kind) {
    let label = tokenLabel[kind] ?? "VALUE"
    let n = (counters[label] ?? 0) + 1
    counters[label] = n
    let entry = VaultEntry(token: "[\(label)_\(n)]", value: value, kind: kind)
    byValue[key(value)] = entry
    entries.append(entry)
  }

  // Full names first, so a lone "Maria" shares the token of "Maria Delgado"
  // when exactly one held name of the same role contains that part.
  let ordered = spans.sorted { $0.text.count > $1.text.count }
  var partOwners: [String: Set<String>] = [:]
  // A lone given name shares the token of the one held name it starts; a lone
  // surname gets its own, since relatives often share one.
  for s in ordered where s.kind.isPerson && s.source != .manual {
    for p in nameParts(s.text).prefix(1) where p != s.text {
      partOwners[key(p), default: []].insert(key(s.text))
    }
  }
  for s in ordered where byValue[key(s.text)] == nil {
    if let owners = partOwners[key(s.text)], owners.count == 1,
      let owner = byValue[owners.first!], owner.kind == s.kind
    {
      byValue[key(s.text)] = owner
    } else {
      issue(s.text, s.kind)
    }
  }

  let ns = text as NSString
  var out = ""
  var at = 0
  for s in spans.sorted(by: { $0.range.location < $1.range.location }) {
    guard let entry = byValue[key(s.text)] else { continue }
    out += ns.substring(with: NSRange(location: at, length: s.range.location - at)) + entry.token
    if s.kind == .dob, let age = ageLabel(s.text, today: today) { out += " (\(age))" }
    at = NSMaxRange(s.range)
  }
  out += ns.substring(from: at)
  // Parts of a held name or place that belong to exactly one held value seal
  // to its token wherever else they turn up (the task line). Values keep their
  // original casing, so sealing matches the same way holding does.
  var original: [String: String] = [:]
  var partOf: [String: Set<String>] = [:]
  for s in spans {
    original[key(s.text)] = s.text
    if s.source == .manual { continue }
    let parts = s.kind.isPerson
      ? Array(nameParts(s.text).prefix(1))
      : (s.kind == .organization || s.kind == .address ? placeParts(s.text) : [])
    for p in parts {
      if original[key(p)] == nil { original[key(p)] = p }
      partOf[key(p), default: []].insert(key(s.text))
    }
  }
  for (part, owners) in partOf where owners.count == 1 && byValue[part] == nil {
    if let owner = byValue[owners.first!] { byValue[part] = owner }
  }
  let lookup = byValue.map { (original[$0.key] ?? $0.value.value, $0.value.token) }
  return Redaction(redacted: out, entries: entries, lookup: lookup)
}

/// Swaps every held string in other text (the task line) for its token.
func sealText(_ text: String, lookup: [(String, String)]) -> String {
  var out = text
  for (value, token) in lookup.sorted(by: { $0.0.count > $1.0.count }) where !token.isEmpty {
    let range = NSRange(location: 0, length: (out as NSString).length)
    out = heldPattern(value).stringByReplacingMatches(
      in: out, range: range, withTemplate: NSRegularExpression.escapedTemplate(for: token))
  }
  return out
}

struct Restoration {
  var text: String
  var restored: Int
  var unknown: [String]
}

func restore(_ text: String, entries: [VaultEntry]) -> Restoration {
  let byToken = Dictionary(entries.map { ($0.token, $0.value) }, uniquingKeysWith: { a, _ in a })
  let ns = text as NSString
  var out = ""
  var at = 0
  var restored = 0
  var unknown: [String] = []
  for m in tokenRegex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
    out += ns.substring(with: NSRange(location: at, length: m.range.location - at))
    let token = ns.substring(with: m.range)
    if let value = byToken[token] {
      out += value
      restored += 1
    } else {
      out += token
      if !unknown.contains(token) { unknown.append(token) }
    }
    at = NSMaxRange(m.range)
  }
  out += ns.substring(from: at)
  return Restoration(text: out, restored: restored, unknown: unknown)
}

/// Every held value found as a whole word in text bound for the cloud.
func findLeaks(_ payload: String, values: [String]) -> [String] {
  var found: [String] = []
  let range = NSRange(location: 0, length: (payload as NSString).length)
  for v in values where v.count >= 2 && !found.contains(v.lowercased()) {
    if heldPattern(v).firstMatch(in: payload, range: range) != nil { found.append(v.lowercased()) }
  }
  return found
}
