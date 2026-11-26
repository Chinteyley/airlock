import SwiftUI

struct AuditRow: Identifiable {
  var id: String
  var title: String
  var split: String
  var identifiers: Int
  var patternLeaks: [String]
  var airlockLeaks: [String]
  var ms: Int
}

/// Runs the labeled notes through the on-device scan and counts what would still reach the cloud.
struct AuditScreen: View {
  let device: DeviceState
  @State private var rows: [AuditRow] = []
  @State private var running = false
  @State private var error: String?

  private func total(_ split: String? = nil, _ f: (AuditRow) -> Int) -> Int {
    rows.filter { split == nil || $0.split == split }.reduce(0) { $0 + f($1) }
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        Text("\(fixtures.count) synthetic notes, \(fixtures.reduce(0) { $0 + $1.identifiers.count }) labeled identifiers. Each note is scanned on this iPhone, then the text bound for the cloud is checked for every labeled value.")
          .font(.callout).foregroundStyle(Theme.text2)
        HStack(spacing: 10) {
          stat("LEAKED WITH AIRLOCK", rows.isEmpty ? "–" : "\(total { $0.airlockLeaks.count })", total { $0.identifiers },
               color: total { $0.airlockLeaks.count } == 0 ? Theme.held : Theme.danger)
          stat("PATTERNS ALONE", rows.isEmpty ? "–" : "\(total { $0.patternLeaks.count })", total { $0.identifiers }, color: Theme.danger)
        }
        if !rows.isEmpty {
          Text("Tuning \(total("tuning") { $0.airlockLeaks.count }) of \(total("tuning") { $0.identifiers }) · held-out \(total("holdout") { $0.airlockLeaks.count }) of \(total("holdout") { $0.identifiers }) · mean scan \(String(format: "%.1f", Double(total { $0.ms }) / Double(max(rows.count, 1)) / 1000)) s")
            .font(.caption).foregroundStyle(Theme.text3)
        }
        PrimaryButton(title: running ? "Scanning \(rows.count + 1) of \(fixtures.count)…" : "Run the audit", busy: running) {
          Task { await run() }
        }
        .disabled(running || device != .ready)
        if device != .ready { Banner(text: "The audit needs the on-device model.", color: Theme.warn) }
        if let error { Banner(text: error, color: Theme.danger) }
        ForEach(rows) { r in
          VStack(alignment: .leading, spacing: 4) {
            HStack {
              Text(r.title).font(.subheadline.weight(.medium)).foregroundStyle(Theme.text)
              if r.split == "holdout" { Text("HELD OUT").font(.system(size: 9, weight: .bold, design: .monospaced)).foregroundStyle(Theme.text2) }
              Spacer()
              Text("\(r.airlockLeaks.count) / \(r.identifiers)").font(.subheadline.weight(.bold)).monospacedDigit()
                .foregroundStyle(r.airlockLeaks.isEmpty ? Theme.held : Theme.danger)
            }
            Text("patterns alone leak \(r.patternLeaks.count) · \(String(format: "%.1f", Double(r.ms) / 1000)) s")
              .font(.caption).foregroundStyle(Theme.text3)
            if !r.airlockLeaks.isEmpty { Text(r.airlockLeaks.joined(separator: ", ")).font(.caption).foregroundStyle(Theme.danger) }
          }
          .padding(12)
          .background(Theme.panel, in: RoundedRectangle(cornerRadius: 12))
        }
      }
      .padding(16)
    }
    .background(Theme.ground)
  }

  private func stat(_ label: String, _ value: String, _ of: Int, color: Color) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(label).font(.caption2.weight(.semibold)).foregroundStyle(Theme.text3)
      HStack(alignment: .firstTextBaseline, spacing: 4) {
        Text(value).font(.system(size: 36, weight: .heavy)).foregroundStyle(color).monospacedDigit()
        Text("of \(of == 0 ? fixtures.reduce(0) { $0 + $1.identifiers.count } : of)").font(.callout.weight(.semibold)).foregroundStyle(Theme.text2)
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Theme.panel, in: RoundedRectangle(cornerRadius: 14))
  }

  private func run() async {
    running = true
    error = nil
    rows = []
    defer { running = false }
    for f in fixtures {
      let truth = f.identifiers.map(\.text)
      let patternOnly = redact(f.text, spans: patternSpans(f.text)).redacted
      do {
        let s = try await scan(f.text)
        let redacted = redact(f.text, spans: s.spans).redacted
        rows.append(AuditRow(
          id: f.id, title: f.title, split: f.split, identifiers: truth.count,
          patternLeaks: findLeaks(patternOnly, values: truth), airlockLeaks: findLeaks(redacted, values: truth), ms: s.ms))
      } catch {
        self.error = "\(f.title): \(error.localizedDescription)"
        return
      }
    }
  }
}

struct HistoryScreen: View {
  @State private var drafts: [StoredDraft]?
  @State private var error: String?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        Text("Letters are saved to Firestore as the cloud wrote them, tokens and all. The real values never leave the device that held them.")
          .font(.callout).foregroundStyle(Theme.text2)
        if let error { Banner(text: error, color: Theme.danger) }
        if drafts == nil && error == nil { ProgressView() }
        ForEach(drafts ?? []) { d in
          VStack(alignment: .leading, spacing: 6) {
            HStack {
              Text(d.title).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.text)
              Spacer()
              Text(d.platform.uppercased()).font(.system(size: 10, weight: .bold, design: .monospaced)).foregroundStyle(Theme.text2)
            }
            Text("\(d.held) held · \(d.leaked) leaked · \(d.draftedOn)").font(.caption).foregroundStyle(Theme.text3)
            Text(tokenText(d.redactedLetter)).font(.caption).foregroundStyle(Theme.text2).lineLimit(6)
          }
          .padding(12)
          .background(Theme.panel, in: RoundedRectangle(cornerRadius: 12))
        }
      }
      .padding(16)
    }
    .background(Theme.ground)
    .task {
      do { drafts = try await History.list() } catch { self.error = error.localizedDescription }
    }
    .refreshable {
      do { drafts = try await History.list() } catch { self.error = error.localizedDescription }
    }
  }
}
