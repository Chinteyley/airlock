// Finds identifiers in a note: pattern detectors for structured values, and
// spans for whatever the on-device model names. A port of web/src/lib/detect.ts;
// offsets are UTF-16 so they line up with NSRegularExpression and NSString.

import Foundation

enum Kind: String, Codable, CaseIterable, Sendable {
  case patient, relative, clinician, person, organization, address, date, dob, phone, email, record, url

  var isPerson: Bool { [.patient, .relative, .clinician, .person].contains(self) }

  var label: String {
    switch self {
    case .patient: "patient"
    case .relative: "relative"
    case .clinician: "clinician"
    case .person: "person"
    case .organization: "organization"
    case .address: "place"
    case .date: "date"
    case .dob: "birth date"
    case .phone: "phone"
    case .email: "email"
    case .record: "record number"
    case .url: "link"
    }
  }
}

enum Source: Int, Sendable {
  case onDevice = 1, pattern = 2, manual = 3
}

struct Span: Hashable, Sendable {
  var range: NSRange
  var text: String
  var kind: Kind
  var source: Source
}

private struct Pattern {
  let kind: Kind
  let re: NSRegularExpression
  let group: Int
}

private func rx(_ p: String, _ opts: NSRegularExpression.Options = []) -> NSRegularExpression {
  // Patterns are constants; a bad one is a programming error.
  try! NSRegularExpression(pattern: p, options: opts)
}

private let months = "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?"
private let street = "Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr|Boulevard|Blvd|Court|Ct|Way|Place|Pl|Terrace|Circle|Highway|Hwy|Parkway|Pkwy"
private let states = "AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|PR"
private let unit = "(?:Apt|Apartment|Unit|Suite|Ste|Bldg|Building|Floor|Fl|Room|Rm)"
private let credentials = "MD|DO|PA-C|PA|NP|RN|LPN|PT|DPT|OT|PhD|PsyD|LCSW|LMFT|MSW|PHN|CNM|DNP|MS|CCC-SLP|SLP"
/// Codes that are also credentials or clinical shorthand are left out of "City, ST".
private let cityStates = states.split(separator: "|").filter { !["MD", "PA", "MS", "CT", "MI"].contains($0) }
  .joined(separator: "|")
/// "Sister" or "sister": a relation word in either case.
private let relations = "sister|brother|son|daughter|wife|husband|mother|mom|father|dad|partner|roommate|friend|aunt|uncle|cousin|niece|nephew|grandson|granddaughter|grandmother|grandfather|fiancée?|boyfriend|girlfriend"
  .split(separator: "|").map { w in "[\(w.prefix(1).uppercased())\(w.prefix(1))]\(w.dropFirst())" }.joined(separator: "|")
/// One capitalized name word, with an apostrophe or inner capital ("O'Brien", "McDonald").
private let nameWord = "\\p{Lu}['’]?\\p{Lu}?\\p{Ll}+(?:\\p{Lu}\\p{Ll}+)?"

private let patterns: [Pattern] = [
  Pattern(kind: .email, re: rx(#"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"#), group: 0),
  Pattern(kind: .url, re: rx(#"\bhttps?://[^\s)]+"#), group: 0),
  Pattern(kind: .record, re: rx(#"\b\d{3}-\d{2}-\d{4}\b"#), group: 0),
  Pattern(kind: .phone, re: rx(#"(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b"#), group: 0),
  Pattern(kind: .date, re: rx(#"\b\d{1,2}/\d{1,2}/\d{2,4}\b"#), group: 0),
  Pattern(kind: .date, re: rx(#"\b\d{4}-\d{2}-\d{2}\b"#), group: 0),
  Pattern(kind: .date, re: rx("\\b(?:\(months))\\.? \\d{1,2},? \\d{4}\\b"), group: 0),
  Pattern(kind: .date, re: rx("\\b\\d{1,2} (?:\(months))\\.?,? \\d{4}\\b"), group: 0),
  Pattern(
    kind: .record,
    re: rx(#"\b(?:MRN|medical record(?: number)?|member ID|Medicaid ID|Medicare ID|student ID|patient ID|account(?: number)?|policy(?: number)?|chart(?: number)?|case(?: number)?|file(?: number)?|claim(?: number)?|SSN|social security number(?: on intake)?|ID)\b[\s:#]*((?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{4,})"#, .caseInsensitive),
    group: 1
  ),
  // After the labeled record numbers, so "Medicaid ID 0039948217" stays a record.
  Pattern(kind: .phone, re: rx(#"(?:\+\d{1,3}[\s.-]?)?\b\d{10,11}\b"#), group: 0),
  Pattern(kind: .address, re: rx("\\b\\d{1,6}\\s+(?:[A-Z][a-z]+\\s){1,3}(?:\(street))\\b\\.?"), group: 0),
  // A city right after a street address: "2231 Lakeshore Drive, Duluth".
  Pattern(
    kind: .address,
    re: rx("\\b\\d{1,6}\\s+(?:[A-Z][a-z]+\\s){1,3}(?:\(street))\\b\\.?,[ \\t]+(?:\(unit)\\.?[ \\t]+[A-Za-z0-9-]+,[ \\t]+)?(?!\(unit)\\b)([A-Z][a-z]+(?: [A-Z][a-z]+)?)"),
    group: 1),
  // MD and PA are left out here: "Alan Whitcomb, MD" is a clinician, not a city.
  Pattern(kind: .address, re: rx("\\b([A-Z][a-z]+(?: [A-Z][a-z]+)?),\\s(?:\(cityStates))\\b"), group: 1),
  Pattern(kind: .address, re: rx("\\b(?:\(states))\\s(\\d{5}(?:-\\d{4})?)\\b"), group: 1),
  Pattern(kind: .relative, re: rx("\\b(?:\(relations))\\b,?[ \\t]+(?:(?:Mr|Mrs|Ms|Mx|Dr)\\.?[ \\t]+)?(\(nameWord)(?:[ \\t-]\(nameWord))?)"), group: 1),
  // A name before a credential, as in a signature: "Jordan Price, PT".
  Pattern(kind: .clinician, re: rx("(\(nameWord)(?:[ \\t]+(?:\\p{Lu}\\.[ \\t]+)?\(nameWord)){1,2}),[ \\t]*(?:\(credentials))\\b"), group: 1),
  Pattern(kind: .person, re: rx("\\b(?:Dr|Mr|Mrs|Ms|Mx|Officer|Nurse|Coach)\\.?[ \\t]+(\(nameWord)(?:[ \\t-]\(nameWord))*)"), group: 1),
]

private let dobCue = rx(#"(?:DOB|D\.O\.B\.|born|date of birth|birth ?date)[\s:(]*$"#, .caseInsensitive)

func findPatterns(_ text: String) -> [Span] {
  let ns = text as NSString
  var spans: [Span] = []
  for p in patterns {
    for m in p.re.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
      let r = m.range(at: p.group)
      guard r.location != NSNotFound, r.length > 0 else { continue }
      var kind = p.kind
      if kind == .date {
        let start = max(0, r.location - 18)
        let before = ns.substring(with: NSRange(location: start, length: r.location - start))
        if dobCue.firstMatch(in: before, range: NSRange(location: 0, length: (before as NSString).length)) != nil {
          kind = .dob
        }
      }
      spans.append(Span(range: r, text: ns.substring(with: r), kind: kind, source: .pattern))
    }
  }
  return spans
}

struct ModelEntity: Sendable {
  var text: String
  var kind: String
}

private let modelKinds: [String: Kind] = [
  "patient": .patient, "relative": .relative, "clinician": .clinician,
  "person": .person, "organization": .organization, "place": .address,
]

/// Titles, credentials and suffixes are never name parts on their own.
private let titles: Set<String> = Set(
  "dr mr mrs ms mx miss officer nurse the and md do pa pa-c np rn lpn pt ot dpt phd psyd lcsw lmft msw phn cnm dnp slp ccc-slp sr jr ii iii"
    .split(separator: " ").map(String.init))

private let generic: Set<String> = Set(
  "primary emergency urgent oncology cardiology pediatric pediatrics adult adolescent women womens behavioral mental surgical surgery rehab rehabilitation radiology orthopedic orthopedics neurology psychiatry psychiatric dental eye vision kidney transplant cancer heart sleep pain wellness family medicine medical center centre hospital clinic clinics health healthcare behavioral services service care partners associates group school high elementary academy university college county city state regional general community memorial children's women's mercy saint st. st north south east west northside southside the of and at for on street avenue road lane drive court boulevard program programs recovery hospice physical therapy motion teen club bank golf packing"
    .split(separator: " ").map(String.init)
)

private func isCapitalized(_ w: String) -> Bool {
  guard let f = w.unicodeScalars.first else { return false }
  return CharacterSet.uppercaseLetters.contains(f)
}

/// Short words and name particles ("De", "La") that are never name parts alone.
private let shortWords: Set<String> = Set(
  "in on at to of or as is it no so he we my by up do go an am be me us if de la le el al di da du van von der den del dos das"
    .split(separator: " ").map(String.init))

/// Name parts ("Maria" from "Maria Delgado", "Tanaka" and "Reyes" from
/// "Tanaka-Reyes") so later mentions are held too.
func nameParts(_ name: String) -> [String] {
  let words = name.split(whereSeparator: \.isWhitespace)
    .map { String($0).trimmingCharacters(in: CharacterSet(charactersIn: "\"'(),.;:")) }
  let pieces = words + words.filter { $0.contains("-") }.flatMap { $0.split(separator: "-").map(String.init) }
  var seen = Set<String>()
  return pieces.filter {
    $0.count >= 2 && $0 != name && isCapitalized($0) && !titles.contains($0.lowercased())
      && !shortWords.contains($0.lowercased()) && seen.insert($0).inserted
  }
}

/// Distinctive words of a held place or organization ("Ames" from "Ames Family Medicine").
func placeParts(_ value: String) -> [String] {
  let words = value.split(whereSeparator: \.isWhitespace).map(String.init)
  guard words.count >= 2 else { return [] }
  return words.filter { w in
    guard w.count >= 3, let s = w.unicodeScalars.first, let t = w.unicodeScalars.dropFirst().first else { return false }
    return CharacterSet.uppercaseLetters.contains(s) && CharacterSet.lowercaseLetters.contains(t)
      && !generic.contains(w.lowercased())
  }
}

/// How a held value is found anywhere: in any case, with any whitespace
/// between its words, and only as a whole word ("_" counts as a word
/// character, so "DATE" never matches inside a "[DATE_1]" token).
func heldPattern(_ value: String) -> NSRegularExpression {
  let body = { (v: String) in
    v.split(whereSeparator: \.isWhitespace).map { NSRegularExpression.escapedPattern(for: String($0)) }
      .joined(separator: "\\s+")
  }
  // A single word is matched as written, title-cased or in capitals, never in
  // lowercase ("low mood", "don't"); three letters or fewer only as written or
  // title-cased ("NG tube", "ED visits"). Several words match in any case.
  // Record numbers, emails and other tokens with digits or punctuation match in any case.
  let single = !value.isEmpty && value.allSatisfy(\.isLetter)
  // An all-caps name ("MCDONALD") also matches its usual spelling ("McDonald").
  let capsRest = { (w: String) in
    NSRegularExpression.escapedPattern(for: String(w.prefix(1)))
      + "(?i:\(NSRegularExpression.escapedPattern(for: String(w.dropFirst()))))"
  }
  let alternatives: [String]
  if single && value.count <= 3 {
    alternatives = Array(Set([value, value.capitalized])).map(body)
  } else if single {
    alternatives = [body(value), capsRest(value.uppercased())]
  } else {
    alternatives = [body(value)]
  }
  return rx(
    "(?<![\\p{L}\\p{N}_])(?:\(alternatives.joined(separator: "|")))(?![\\p{L}\\p{N}_]|['’]t\\b)",
    single ? [] : .caseInsensitive)
}

private func occurrences(of needle: String, in text: String) -> [NSRange] {
  heldPattern(needle).matches(in: text, range: NSRange(location: 0, length: (text as NSString).length)).map(\.range)
}

private let titlePrefix = rx(#"^(?:Dr|Mr|Mrs|Ms|Mx)\.?\s+"#)

/// Every occurrence of each entity, and of each part of a person's name.
func spansFromEntities(_ text: String, _ entities: [ModelEntity], source: Source = .onDevice) -> [Span] {
  var spans: [Span] = []
  for e in entities {
    let kind = modelKinds[e.kind] ?? .person
    var value = e.text.trimmingCharacters(in: .whitespacesAndNewlines)
    value = titlePrefix.stringByReplacingMatches(
      in: value, range: NSRange(location: 0, length: (value as NSString).length), withTemplate: "")
    guard value.count >= 2 else { continue }
    // Parts are tried even when the full value isn't in the note verbatim. A
    // manual hold is held exactly as selected, without parts.
    let needles = source == .manual ? [value] : [value] + (kind.isPerson ? nameParts(value) : placeParts(value))
    let ns = text as NSString
    for n in needles {
      for r in occurrences(of: n, in: text) {
        spans.append(Span(range: r, text: ns.substring(with: r), kind: kind, source: source))
      }
    }
  }
  return spans
}

/// Every occurrence of every span's text (and of a person's name parts), so a
/// value found once, by any detector, is held everywhere it appears.
func expandSpans(_ text: String, _ spans: [Span]) -> [Span] {
  var out = spans
  var seen = Set<String>()
  let ns = text as NSString
  for s in spans where s.source != .manual && seen.insert("\(s.kind):\(s.text.lowercased())").inserted {
    for n in [s.text] + (s.kind.isPerson ? nameParts(s.text) : []) {
      for r in occurrences(of: n, in: text) {
        out.append(Span(range: r, text: ns.substring(with: r), kind: s.kind, source: s.source))
      }
    }
  }
  return out
}

/// Overlapping spans become one span covering all of them, so no detector can
/// shrink what another held. The longest span (manual, then pattern, then model
/// on a tie) names the kind.
func mergeSpans(_ spans: [Span], in text: String) -> [Span] {
  let ns = text as NSString
  let sorted = spans.sorted {
    $0.range.location != $1.range.location ? $0.range.location < $1.range.location : NSMaxRange($0.range) > NSMaxRange($1.range)
  }
  var out: [Span] = []
  for s in sorted {
    guard var last = out.last, s.range.location < NSMaxRange(last.range) else {
      out.append(s)
      continue
    }
    let lead = s.range.length > last.range.length
      || (s.range.length == last.range.length && s.source.rawValue > last.source.rawValue)
    let end = max(NSMaxRange(last.range), NSMaxRange(s.range))
    if lead {
      last.kind = s.kind
      last.source = s.source
    }
    last.range = NSRange(location: last.range.location, length: end - last.range.location)
    last.text = ns.substring(with: last.range)
    out[out.count - 1] = last
  }
  return out
}
