// StarlinkBar.swift - native macOS menu bar client for starlink-monitor.
//
// Deliberately thin: it renders what the local server already computed and
// never measures anything itself. All logic lives in the Bun probe so there is
// one source of truth for thresholds and alert state.
//
// Build:  swiftc -O StarlinkBar.swift -o StarlinkBar
// Runs as an accessory app, so no Dock icon and no window until asked.

import AppKit
import Foundation

let PORT = ProcessInfo.processInfo.environment["STARLINK_PORT"] ?? "8787"
let BASE = "http://127.0.0.1:\(PORT)"

struct Alert: Decodable {
    let code: String
    let severity: String
    let message: String
    let fix: String?
}

/// Past this, the probes have stopped and every number below it is history.
/// `light` runs every 5 minutes, so 15 is three missed runs, not a blip.
let STALE_AFTER: TimeInterval = 900

struct Status: Decodable {
    /// Timestamp of the newest measurement. Decoded solely so the menu bar can
    /// refuse to present old readings as current: the server can be perfectly
    /// healthy while the probe jobs are unregistered, and without this the bar
    /// shows last week's numbers with no hint that nothing is measuring.
    let ts: String?
    let state: String
    let lineDownMbps: Double?
    let lineUpMbps: Double?
    let popPingMs: Double?
    let wifiSnr: Double?
    let loadedMs: Double?
    let vpnActive: Bool
    let vpnName: String?
    let dishReachable: Bool
    let alerts: [Alert]
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    var timer: Timer?
    var latest: Status?

    /// Double-clicking the Desktop icon while the agent is already running sends
    /// a reopen rather than launching a second copy. Treat that as "show me the
    /// dashboard", which is the only thing a click could sensibly mean for an
    /// app with no windows of its own.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        openDash()
        return true
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.accessory)
        // Launched by a click rather than by launchd: the user wants the
        // dashboard. Launchd sets this variable so the boot path stays silent.
        if ProcessInfo.processInfo.environment["STARLINK_AGENT"] != "1" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.openDash() }
        }
        item.button?.font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .medium)
        setTitle("Starlink …", color: .secondaryLabelColor)
        rebuildMenu()
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    func setTitle(_ text: String, color: NSColor) {
        item.button?.attributedTitle = NSAttributedString(
            string: text,
            attributes: [.foregroundColor: color,
                         .font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .medium)]
        )
    }

    func refresh() {
        guard let url = URL(string: "\(BASE)/api/status") else { return }
        var req = URLRequest(url: url)
        req.timeoutInterval = 8
        URLSession.shared.dataTask(with: req) { [weak self] data, _, err in
            guard let self else { return }
            DispatchQueue.main.async {
                guard let data, err == nil,
                      let s = try? JSONDecoder().decode(Status.self, from: data) else {
                    // Server down is its own visible state, never a stale number.
                    self.latest = nil
                    self.setTitle("Starlink offline", color: .systemOrange)
                    self.rebuildMenu()
                    return
                }
                self.latest = s
                self.render(s)
                self.rebuildMenu()
            }
        }.resume()
    }

    /// Age of the newest measurement, or nil if the server did not give one.
    func age(_ s: Status) -> TimeInterval? {
        guard let ts = s.ts else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let d = f.date(from: ts) ?? ISO8601DateFormatter().date(from: ts) else { return nil }
        return Date().timeIntervalSince(d)
    }

    func render(_ s: Status) {
        // Silence is a state, and it outranks every reading. If the probes have
        // stopped, say so instead of drawing numbers that are no longer true.
        if let a = age(s), a > STALE_AFTER {
            let mins = Int(a / 60)
            let label = mins < 120 ? "\(mins)m" : "\(mins / 60)h"
            setTitle("Starlink stale \(label)", color: .systemOrange)
            return
        }

        let color: NSColor
        switch s.state {
        case "ok":       color = .secondaryLabelColor
        case "critical": color = .systemRed
        case "warn":     color = .systemOrange
        default:         color = .secondaryLabelColor
        }

        var parts: [String] = []
        if let d = s.lineDownMbps { parts.append("\(Int(d))↓") }
        if let u = s.lineUpMbps   { parts.append("\(Int(u))↑") }
        if let p = s.popPingMs    { parts.append("\(Int(p))ms") }
        if s.vpnActive            { parts.append("VPN") }
        if !s.dishReachable       { parts.append("no dish") }

        setTitle(parts.isEmpty ? "Starlink" : parts.joined(separator: "  "), color: color)
    }

    func rebuildMenu() {
        let menu = NSMenu()

        if let s = latest {
            // "All clear" must never be said over dead data. If nothing has been
            // measured recently, that is the headline, not the alert count.
            let stale = (age(s) ?? 0) > STALE_AFTER
            let head: String
            if stale {
                head = "Not measuring. Run ./install.sh status"
            } else {
                head = s.alerts.isEmpty ? "All clear" : "\(s.alerts.count) needs attention"
            }
            menu.addItem(withTitle: head, action: nil, keyEquivalent: "")

            for a in s.alerts.prefix(5) {
                let mi = NSMenuItem(title: "  \(a.message)", action: nil, keyEquivalent: "")
                if let fix = a.fix {
                    mi.toolTip = fix
                    let sub = NSMenu()
                    sub.addItem(withTitle: fix, action: nil, keyEquivalent: "")
                    mi.submenu = sub
                }
                menu.addItem(mi)
            }
            menu.addItem(.separator())

            func row(_ label: String, _ value: String) {
                menu.addItem(withTitle: "\(label)   \(value)", action: nil, keyEquivalent: "")
            }
            row("Line down", s.lineDownMbps.map { "\(Int($0)) Mbps" } ?? "not tested")
            row("Line up  ", s.lineUpMbps.map { "\(Int($0)) Mbps" } ?? "not tested")
            row("PoP ping ", s.popPingMs.map { "\(Int($0)) ms" } ?? "--")
            row("Wi-Fi SNR", s.wifiSnr.map { "\(Int($0)) dB" } ?? "--")
            row("Loaded   ", s.loadedMs.map { "\(Int($0)) ms" } ?? "--")
            if s.vpnActive { row("VPN      ", s.vpnName ?? "active") }
        } else {
            menu.addItem(withTitle: "Monitor service not running", action: nil, keyEquivalent: "")
        }

        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Open dashboard", action: #selector(openDash), keyEquivalent: "d"))
        menu.addItem(NSMenuItem(title: "Run speed test", action: #selector(speedTest), keyEquivalent: "t"))
        menu.addItem(NSMenuItem(title: "Refresh now", action: #selector(refreshNow), keyEquivalent: "r"))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        menu.items.forEach { $0.target = $0.target ?? self }
        item.menu = menu
    }

    @objc func openDash() {
        if let u = URL(string: BASE) { NSWorkspace.shared.open(u) }
    }

    @objc func refreshNow() { refresh() }

    @objc func speedTest() {
        setTitle("Starlink testing…", color: .secondaryLabelColor)
        guard let url = URL(string: "\(BASE)/api/speedtest") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 120
        URLSession.shared.dataTask(with: req) { [weak self] _, _, _ in
            DispatchQueue.main.async { self?.refresh() }
        }.resume()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
