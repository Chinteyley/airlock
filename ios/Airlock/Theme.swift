import SwiftUI

enum Theme {
  static let ground = Color(red: 0.031, green: 0.035, blue: 0.043)
  static let panel = Color(red: 0.067, green: 0.075, blue: 0.094)
  static let panel2 = Color(red: 0.090, green: 0.102, blue: 0.129)
  static let line = Color(red: 0.149, green: 0.169, blue: 0.208)
  static let text = Color(red: 0.961, green: 0.969, blue: 0.980)
  static let text2 = Color(red: 0.765, green: 0.792, blue: 0.835)
  static let text3 = Color(red: 0.549, green: 0.584, blue: 0.639)
  static let held = Color(red: 0.243, green: 0.902, blue: 0.690)
  static let heldInk = Color(red: 0.024, green: 0.165, blue: 0.122)
  static let cloud = Color(red: 0.561, green: 0.706, blue: 1.0)
  static let warn = Color(red: 1.0, green: 0.710, blue: 0.278)
  static let danger = Color(red: 1.0, green: 0.420, blue: 0.420)
}

/// Text with held spans tinted, from UTF-16 ranges.
func heldText(_ text: String, spans: [Span]) -> AttributedString {
  let ns = text as NSString
  var out = AttributedString()
  var at = 0
  for s in spans {
    if s.range.location > at {
      out += AttributedString(ns.substring(with: NSRange(location: at, length: s.range.location - at)))
    }
    var mark = AttributedString(ns.substring(with: s.range))
    mark.foregroundColor = Theme.held
    mark.backgroundColor = Theme.held.opacity(0.14)
    mark.font = .body.weight(.semibold)
    mark.underlineStyle = .single
    out += mark
    at = NSMaxRange(s.range)
  }
  out += AttributedString(ns.substring(from: at))
  return out
}

/// Text with tokens shown as pills, or swapped for their values when restoring.
func tokenText(_ text: String, entries: [VaultEntry] = [], restore: Bool = false, mono: Bool = false) -> AttributedString {
  let byToken = Dictionary(entries.map { ($0.token, $0.value) }, uniquingKeysWith: { a, _ in a })
  let ns = text as NSString
  var out = AttributedString()
  var at = 0
  func plain(_ s: String) -> AttributedString {
    var a = AttributedString(s)
    if mono { a.font = .system(.caption, design: .monospaced) }
    return a
  }
  for m in tokenRegex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
    out += plain(ns.substring(with: NSRange(location: at, length: m.range.location - at)))
    let token = ns.substring(with: m.range)
    if restore, let value = byToken[token] {
      var a = AttributedString(value)
      a.font = .body.weight(.semibold)
      a.underlineStyle = .single
      a.foregroundColor = Theme.text
      out += a
    } else {
      var a = AttributedString(token)
      a.font = .system(mono ? .caption : .callout, design: .monospaced).weight(.semibold)
      a.foregroundColor = Theme.held
      a.backgroundColor = Theme.held.opacity(0.14)
      out += a
    }
    at = NSMaxRange(m.range)
  }
  out += plain(ns.substring(from: at))
  return out
}

struct Card<Content: View>: View {
  var title: String
  var badge: String?
  var badgeColor: Color = Theme.text2
  @ViewBuilder var content: Content

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 8) {
        Text(title).font(.headline).foregroundStyle(Theme.text)
        if let badge {
          Text(badge)
            .font(.system(size: 10, weight: .semibold, design: .monospaced))
            .foregroundStyle(badgeColor)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(badgeColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 5))
            .overlay(RoundedRectangle(cornerRadius: 5).stroke(badgeColor.opacity(0.35)))
        }
        Spacer()
      }
      content
    }
    .padding(16)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Theme.panel, in: RoundedRectangle(cornerRadius: 16))
    .overlay(RoundedRectangle(cornerRadius: 16).stroke(Theme.line))
  }
}

struct PrimaryButton: View {
  var title: String
  var color: Color = Theme.held
  var ink: Color = Theme.heldInk
  var busy = false
  var action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 8) {
        if busy { ProgressView().tint(ink) }
        Text(title).font(.body.weight(.semibold))
      }
      .frame(maxWidth: .infinity)
      .padding(.vertical, 14)
      .foregroundStyle(ink)
      .background(color, in: RoundedRectangle(cornerRadius: 12))
    }
  }
}
