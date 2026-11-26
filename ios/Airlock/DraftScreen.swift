import SwiftUI

struct DraftScreen: View {
  let device: DeviceState
  let policy: Policy?

  enum Phase { case edit, scanning, review, sending, done }

  struct Sent {
    var draft: Draft
    // The vault as it was when the request went out.
    var entries: [VaultEntry]
    var leaks: [String]
  }

  @State private var fixture = fixtures.first
  @State private var note = fixtures.first?.text ?? ""
  @State private var task = fixtures.first?.task ?? ""
  @State private var phase = Phase.edit
  @State private var spans: [Span] = []
  @State private var scanMs = 0
  @State private var sealed = false
  @State private var reviewed = false
  @State private var sent: Sent?
  @State private var saved: String?
  @State private var error: String?
  @State private var showRestored = true
  /// Values the clinician released; they stay released even where a held name contains them.
  @State private var released: Set<String> = []

  private var redaction: Redaction {
    var r = redact(note, spans: spans)
    r.lookup = r.lookup.filter { !released.contains($0.0.lowercased()) }
    return r
  }
  private var heldValues: [String] {
    let stillHeld = Set(spans.map { $0.text.lowercased() })
    return Array(Set(spans.flatMap { s -> [String] in
      if s.kind.isPerson { return [s.text] + nameParts(s.text) }
      if s.kind == .organization || s.kind == .address { return [s.text] + placeParts(s.text) }
      return [s.text]
    }))
    .filter { !released.contains($0.lowercased()) || stillHeld.contains($0.lowercased()) }
  }
  private var sealedTask: String { sealText(task, lookup: redaction.lookup) }
  private var outbound: String {
    buildDraftPrompt(
      redactedNote: redaction.redacted, task: sealedTask, instructions: (policy ?? Policy()).draftInstructions)
  }
  /// Only the user's text is checked; Airlock's fixed wording names no one.
  private var preflightLeaks: [String] {
    findLeaks([(policy ?? Policy()).draftInstructions, redaction.redacted, sealedTask].joined(separator: "\n"), values: heldValues)
  }
  private var canSend: Bool { phase == .review && preflightLeaks.isEmpty && (!sealed || reviewed) }

  var body: some View {
    ScrollView {
      VStack(spacing: 14) {
        deviceCard
        if phase != .edit && phase != .scanning { wireCard }
        if sent != nil || phase == .sending { letterCard }
      }
      .padding(16)
    }
    .background(Theme.ground)
    // A manual review confirms one exact prompt; any change asks for it again.
    .onChange(of: outbound) { reviewed = false }
  }

  // MARK: This device

  private var deviceCard: some View {
    Card(title: "This device", badge: "ON-DEVICE · Apple Intelligence", badgeColor: Theme.held) {
      if phase == .edit || phase == .scanning {
        Menu {
          ForEach(fixtures) { f in
            Button(f.title) { pick(f) }
          }
        } label: {
          HStack {
            Text(fixture?.title ?? "Your note").font(.subheadline.weight(.medium)).lineLimit(1)
            Spacer()
            Image(systemName: "chevron.up.chevron.down").font(.caption)
          }
          .foregroundStyle(Theme.text)
          .padding(10)
          .background(Theme.panel2, in: RoundedRectangle(cornerRadius: 10))
        }
        TextEditor(text: $note)
          .font(.callout)
          .scrollContentBackground(.hidden)
          .foregroundStyle(Theme.text)
          .frame(minHeight: 320)
          .padding(8)
          .background(Theme.panel2, in: RoundedRectangle(cornerRadius: 10))
          .disabled(phase == .scanning)
        PrimaryButton(title: phase == .scanning ? "Scanning on this device…" : "Scan on this device", busy: phase == .scanning) {
          Task { await runScan() }
        }
        .disabled(phase == .scanning || note.isEmpty)
      } else {
        kindChips
        if sealed {
          Banner(
            text: "Sealed. No on-device model is ready, so Airlock won't scan with AI, and it never sends the raw note instead. Patterns held \(spans.count) values.",
            color: Theme.warn)
        }
        Text(heldText(note, spans: spans)).font(.callout).foregroundStyle(Theme.text).textSelection(.enabled)
        if phase == .review && !spans.isEmpty {
          Text("Tap to release").font(.caption).foregroundStyle(Theme.text3)
          FlowChips(values: Array(Set(spans.map(\.text))).sorted()) { value in
            // Releasing a name also releases its parts held elsewhere.
            let kind = spans.first { $0.text == value }?.kind
            let norm = { (t: String) in t.lowercased().split(whereSeparator: \.isWhitespace).joined(separator: " ") }
            // Never release a name part another held name still shares.
            let shared = Set(
              spans.filter { norm($0.text) != norm(value) && $0.kind.isPerson }.flatMap { nameParts($0.text) }.map(norm))
            let parts = kind?.isPerson == true ? nameParts(value).map(norm).filter { !shared.contains($0) } : []
            let gone = Set([norm(value)] + parts)
            spans.removeAll { $0.kind == kind && gone.contains(norm($0.text)) }
            released.formUnion(gone)
          }
        }
        HStack {
          Text(sealed ? "Held by patterns" : "Scanned on this device in \(String(format: "%.1f", Double(scanMs) / 1000)) s")
            .font(.caption).foregroundStyle(Theme.text3)
          Spacer()
          Button("Edit note") { reset() }.font(.caption.weight(.semibold)).disabled(phase == .sending)
        }
      }
      if let error { Banner(text: error, color: Theme.danger) }
    }
  }

  private var kindChips: some View {
    let counts = Dictionary(grouping: redaction.entries, by: \.kind).mapValues(\.count)
    return FlowLayout(spacing: 6) {
      ForEach(Kind.allCases.filter { counts[$0] != nil }, id: \.self) { k in
        HStack(spacing: 4) {
          Text("\(counts[k] ?? 0)").font(.caption.weight(.bold)).foregroundStyle(Theme.held)
          Text(k.label).font(.caption).foregroundStyle(Theme.text2)
        }
        .padding(.horizontal, 9).padding(.vertical, 3)
        .background(Theme.panel2, in: Capsule())
        .overlay(Capsule().stroke(Theme.line))
      }
    }
  }

  // MARK: The wire

  private var wireCard: some View {
    Card(title: "The wire", badge: sent == nil ? "OUTBOUND" : "SENT") {
      let leaks = sent?.leaks ?? preflightLeaks
      VStack(alignment: .leading, spacing: 2) {
        Text(sent == nil ? "HELD IDENTIFIERS IN THE OUTBOUND PROMPT" : "HELD IDENTIFIERS IN THE PROMPT SENT")
          .font(.caption2.weight(.semibold)).foregroundStyle(Theme.text3).tracking(0.6)
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text("\(leaks.count)").font(.system(size: 54, weight: .heavy)).monospacedDigit()
            .foregroundStyle(leaks.isEmpty ? Theme.held : Theme.danger)
          Text("of \(redaction.entries.count) held").font(.title3.weight(.semibold)).foregroundStyle(Theme.text2)
        }
      }
      .padding(14)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Theme.ground, in: RoundedRectangle(cornerRadius: 12))
      if sent == nil && !preflightLeaks.isEmpty {
        Banner(text: "The prompt still contains \(preflightLeaks.joined(separator: ", ")). Airlock won't send it.", color: Theme.danger)
      }
      if let s = sent, s.draft.source == .onDevice {
        Banner(
          text: s.draft.cloudError.map { "The cloud request failed (\($0)), so the letter was drafted on this device." }
            ?? "Drafted on this device.",
          color: Theme.warn)
      }
      Text("The exact prompt handed to Firebase AI Logic:").font(.caption).foregroundStyle(Theme.text3)
      ScrollView {
        Text(tokenText(outbound, mono: true)).foregroundStyle(Theme.text2).frame(maxWidth: .infinity, alignment: .leading)
      }
      .frame(maxHeight: 260)
      .padding(10)
      .background(Theme.ground, in: RoundedRectangle(cornerRadius: 10))
      if sealed && phase == .review {
        Toggle("I read the prompt above, and it names no one.", isOn: $reviewed).font(.caption).tint(Theme.held)
      }
      TextField("Letter to write", text: $task, axis: .vertical)
        .font(.callout).foregroundStyle(Theme.text)
        .padding(10).background(Theme.panel2, in: RoundedRectangle(cornerRadius: 10))
        .disabled(phase != .review)
      if phase == .review || phase == .sending {
        PrimaryButton(
          title: phase == .sending ? "Drafting…" : "Send through the airlock", color: Theme.cloud,
          ink: Color(red: 0.04, green: 0.09, blue: 0.19), busy: phase == .sending
        ) { Task { await send() } }
        .disabled(!canSend)
        .opacity(canSend || phase == .sending ? 1 : 0.45)
      }
    }
  }

  // MARK: The letter

  private var letterCard: some View {
    Card(
      title: "The letter",
      badge: sent.map { $0.draft.source == .inCloud ? "IN_CLOUD · \(policy?.draftModel ?? "")" : "ON_DEVICE · Apple Intelligence" },
      badgeColor: sent?.draft.source == .inCloud ? Theme.cloud : Theme.held
    ) {
      if let s = sent {
        Picker("View", selection: $showRestored) {
          Text("Restored").tag(true)
          Text("As the cloud wrote it").tag(false)
        }
        .pickerStyle(.segmented)
        Text(tokenText(s.draft.text, entries: s.entries, restore: showRestored)).font(.callout)
          .foregroundStyle(Theme.text).textSelection(.enabled)
        let r = restore(s.draft.text, entries: s.entries)
        HStack {
          Text("\(r.restored) values restored on this device · \(String(format: "%.1f", Double(s.draft.ms) / 1000)) s\(saved.map { " · \($0)" } ?? "")")
            .font(.caption).foregroundStyle(Theme.text3)
          Spacer()
          Button(showRestored ? "Copy" : "Copy tokens") {
            UIPasteboard.general.string = showRestored ? r.text : s.draft.text
          }
          .font(.caption.weight(.semibold))
        }
      } else {
        HStack(spacing: 8) {
          ProgressView()
          Text("Drafting on the redacted note…").foregroundStyle(Theme.text2)
        }
      }
    }
  }

  // MARK: Actions

  private func pick(_ f: Fixture) {
    fixture = f
    note = f.text
    task = f.task
    reset()
  }

  private func reset() {
    phase = .edit
    spans = []
    released = []
    sent = nil
    saved = nil
    error = nil
    reviewed = false
  }

  private func runScan() async {
    phase = .scanning
    error = nil
    sealed = device != .ready
    do {
      let s = try await scan(note)
      spans = s.spans
      scanMs = s.ms
    } catch {
      self.error = "On-device scan failed (\(error.localizedDescription)). Continuing sealed."
      sealed = true
      spans = patternSpans(note)
    }
    phase = .review
  }

  private func send() async {
    guard canSend else { return }
    let policy = policy ?? Policy()
    let prompt = outbound
    let entries = redaction.entries
    let held = heldValues
    let redactedNote = redaction.redacted
    let userText = redactedNote + "\n" + sealedTask
    phase = .sending
    error = nil
    let unheld = await unheldInTask(sealedTask)
    guard unheld.isEmpty else {
      error = "The task line names \(unheld.joined(separator: ", ")). Take it out of the task, or put it in the note and scan again."
      phase = .review
      return
    }
    switch await draftLetter(prompt: prompt, model: policy.draftModel) {
    case .success(let draft):
      // What went out is the prompt built and checked above; check its user text once more as sent.
      sent = Sent(draft: draft, entries: entries, leaks: findLeaks(userText, values: held))
      phase = .done
      saved = "saving redacted copy…"
      // The sample's title, unless it names something held.
      let sample = fixture.flatMap { $0.text == note ? $0.title : nil }
      let title = sample.flatMap { findLeaks($0, values: held).isEmpty ? $0 : nil } ?? "Referral letter"
      do {
        try await History.save(
          title: title, redactedNote: redactedNote, redactedLetter: draft.text, held: entries.count,
          leaked: sent?.leaks.count ?? 0, detectedOn: sealed ? "patterns-only" : "on-device",
          draftedOn: draft.source, heldValues: held)
        saved = "redacted copy saved"
      } catch {
        saved = error.localizedDescription
      }
    case .failure(let e):
      error = e.localizedDescription
      phase = .review
    }
  }
}

struct Banner: View {
  var text: String
  var color: Color
  var body: some View {
    Text(text).font(.caption).foregroundStyle(color)
      .padding(10).frame(maxWidth: .infinity, alignment: .leading)
      .background(color.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
      .overlay(RoundedRectangle(cornerRadius: 10).stroke(color.opacity(0.45)))
  }
}

struct FlowChips: View {
  var values: [String]
  var onTap: (String) -> Void
  var body: some View {
    FlowLayout(spacing: 6) {
      ForEach(values, id: \.self) { v in
        Button {
          onTap(v)
        } label: {
          HStack(spacing: 4) {
            Text(v).lineLimit(1)
            Image(systemName: "xmark").font(.system(size: 9, weight: .bold))
          }
          .font(.caption.weight(.semibold))
          .foregroundStyle(Theme.held)
          .padding(.horizontal, 9).padding(.vertical, 4)
          .background(Theme.held.opacity(0.12), in: Capsule())
        }
      }
    }
  }
}

/// Wraps children onto new lines like text.
struct FlowLayout: Layout {
  var spacing: CGFloat = 6

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = proposal.width ?? .infinity
    var x: CGFloat = 0
    var y: CGFloat = 0
    var row: CGFloat = 0
    for s in subviews {
      let size = s.sizeThatFits(.unspecified)
      if x + size.width > width, x > 0 {
        x = 0
        y += row + spacing
        row = 0
      }
      x += size.width + spacing
      row = max(row, size.height)
    }
    return CGSize(width: width == .infinity ? x : width, height: y + row)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var x = bounds.minX
    var y = bounds.minY
    var row: CGFloat = 0
    for s in subviews {
      let size = s.sizeThatFits(.unspecified)
      if x + size.width > bounds.maxX, x > bounds.minX {
        x = bounds.minX
        y += row + spacing
        row = 0
      }
      s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
      x += size.width + spacing
      row = max(row, size.height)
    }
  }
}
