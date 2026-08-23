# starlink-monitor

Menu bar monitor for a Starlink line. Scheduled checks, honest alerts, local only.

Built 13 Aug 2026 after a diagnostic session that established the baseline below.

## What it honestly does

**Monitors.** Every 5 minutes it records dish health, PoP latency, obstruction,
Wi-Fi link quality, and which interface owns the default route. Every hour it
runs Starlink's own dish-to-PoP speed test. Every 6 hours it runs Apple's
`networkQuality` for capacity and latency under load.

**Alerts.** Eight conditions, each with a concrete fix. Alerts deduplicate and
auto-resolve, so the same complaint never appears twice and a cleared condition
clears itself.

**What it does not do:** automatically "optimize" anything. That word is
avoided on purpose. On a Starlink line there is almost nothing that software
running on your Mac is permitted to tune:

| Layer | Tunable? | Why |
| --- | --- | --- |
| Wi-Fi | No | The Starlink router exposes no channel, width or power controls. The real levers are physical: where the router sits, and what else is on the channel |
| Dish | No | Obstruction, thermal and actuator faults are physical. No setting changes them |
| Router | No | Starlink router exposes no QoS or channel controls; `run_iperf_server` returns PermissionDenied |
| VPN | **Yes** | The one real lever, and the one big measured win |
| Bufferbloat | Not from here | Needs a router with SQM. The Starlink router has no such control |

An app claiming to auto-optimize this line would be lying about four of those
five rows. So it reports, and it tells you the one thing you can act on.

Said plainly, because a public README is where this gets softened: there is no
optimize button here and there will not be one. Four of those five rows are not
a lack of effort, they are places where the hardware grants no control to
software on your Mac. A tool that claims otherwise is either changing something
that does not matter or reporting a change it did not make. The useful thing a
monitor can do is tell you which of the five is hurting you today, and say so
when the honest answer is "nothing you can reach from here."

## Example baseline: one line, 13 Aug 2026

**These are one household's measurements, not expected values, and not a
promise.** They are reproduced here because the shipped alert thresholds were
calibrated against them, so you can see what the defaults assume. A dish in a
different cell, on a different continent, with a different obstruction profile
will read nothing like this, and that is normal.

| Metric | Measured on that line |
| --- | --- |
| Line down, dish to PoP | 374 Mbps median, 580 peak |
| Line up | 14.4 to 46.8 Mbps (varies widely) |
| PoP latency | 24 ms |
| Obstruction, 54 h window | 0% |
| Wi-Fi | -54 dBm, 40 dB SNR, ch 48, 80 MHz, 1200 Mbps PHY |
| Latency under load | 189 to 388 ms (bufferbloat, unfixable from here) |
| **VPN cost** | **11.1 Mbps tunnelled vs 26-76 direct** |

### You will probably want to recalibrate

The thresholds live in one block at the top of `src/probe.ts` (`const T`). They
are deliberately derived from a real line rather than from marketing figures,
but they are derived from *that* line. If your line genuinely runs at 60 Mbps,
the shipped 100 Mbps floor will cry congestion at you every hour and you will
correctly stop believing it. Let it collect a few days first, read your own
numbers off the dashboard, then set `T` from those. An alert calibrated to
somebody else's house is noise wearing a warning label.

## Install

Requires macOS 13+, [Bun](https://bun.sh), and the Xcode command line tools for
`swiftc`.

```bash
./install.sh            # builds the .app, registers 5 launchd jobs, adds the Desktop icon
./install.sh status     # health check: are the jobs registered and is data landing?
./install.sh uninstall  # removes jobs, app and icon. Keeps the data
```

Dashboard at http://127.0.0.1:8787 (loopback only, nothing leaves the machine).

`install.sh` does not tell you it worked because `launchctl` returned 0. It
registers the jobs, then checks that all five are in the launchd domain, that
the port answers, and that a fresh measurement actually reached the database.
If any of those is untrue it says NOT HEALTHY and exits non-zero.

## When it stops measuring, and how you find out

This is the failure that matters, so it gets its own section. The menu bar is
served by the `server` job; the measurements come from the `light`, `speedtest`
and `quality` jobs. Those are independent. **The bar can look perfectly alive
while nothing has been measured for days**, because it is happily rendering the
last row in the database.

Two guards against that:

- The menu bar reads the timestamp of the newest measurement. Past 15 minutes,
  three missed `light` runs, it stops showing numbers and shows
  `Starlink stale 4h` instead. A monitor that goes quiet has to say so.
- `./install.sh status` checks registration, port and data freshness, and exits
  non-zero if any of them is wrong. Worth a cron entry if you care.

**Do not assume the agents reload themselves at every login.** They usually do.
But an agent in `~/Library/LaunchAgents` also appears under
**System Settings > General > Login Items & Extensions** as a background item,
and switching it off there boots it out immediately and keeps it off across
reboots, silently, with no error in any log. That is the state this tool was
found in once: menu bar running, four jobs unregistered, four days of no data,
nothing anywhere reporting a problem. If `status` says MISSING, look there
first.

`server` and `menubar` carry `KeepAlive`, so they restart if they crash. That
covers crashes. It does not cover being switched off.

## The Desktop icon

`/Applications/Starlink Monitor.app` is the single copy of the binary: launchd
runs it, and the Desktop alias points at it. `LSUIElement` keeps it out of the
Dock, so it lives in the menu bar only. Clicking the Desktop icon while it is
already running sends a reopen, which `applicationShouldHandleReopen` turns into
"open the dashboard" rather than launching a second copy. Launchd sets
`STARLINK_AGENT=1` so the boot path stays silent and does not pop a browser
window every time you log in.

**The bundle identifier must not equal the launchd label.** `CFBundleIdentifier`
is `com.8gi.starlink.desktop` while the launchd label is
`com.8gi.starlink.menubar`. When both were the same string, LaunchServices had
the bundle registered under that identifier and launchd refused the job with
`Bootstrap failed: 5: Input/output error`.

**Keep exactly one copy of the .app on disk.** The same
`Bootstrap failed: 5: Input/output error` comes back if a second bundle with the
same `CFBundleIdentifier` exists anywhere, because `build-app.sh` ends with an
`lsregister -f` and LaunchServices then knows two bundles claiming one
identifier. Building the bundle to a scratch path for testing is enough to
cause it, and the error names neither the duplicate nor the path. To find and
clear one:

```bash
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
$LSR -dump | grep -i "path:" | grep -i "Starlink Monitor.app" | sort -u   # expect one line
$LSR -u "/path/to/the/stray/Starlink Monitor.app"                          # then delete it
```

## Layout

| Path | Role |
| --- | --- |
| `src/starlink.ts` | gRPC to dish (`192.168.100.1:9200`) and router (`192.168.1.1:9000`) |
| `src/system.ts` | Wi-Fi link, default route, VPN detection, `networkQuality` |
| `src/probe.ts` | One scheduled measurement, then exit. Alert evaluation lives here |
| `src/db.ts` | SQLite at `~/.8gent/starlink/monitor.db`, stateful alerts |
| `src/server.ts` | Loopback API + dashboard |
| `src/dashboard.html` | Charts, current state, one-click speed test |
| `menubar/StarlinkBar.swift` | Native `NSStatusItem`, no Dock icon |

## Two things that will bite anyone editing this

**The dish history is a ring buffer.** `dishGetHistory` returns fixed-size
arrays plus a `current` counter that increments forever. The newest sample is at
`(current - 1) % length`, **not** at the end of the array. Slicing the tail
reads an arbitrary window of history. This produced two confidently wrong
readings before it was caught. `getHistory()` unwraps it correctly.

**Speed test samples are nested under `status`.** The response shape is
`{getSpeedtestStatus: {status: {running, down: {throughputsMbps}, ...}}}`.
Reading `down` off the response root yields undefined forever and the poll
never completes. `running` is simply absent once the test finishes.

## Schedule

| Job | Interval | Cost | Runs at load |
| --- | --- | --- | --- |
| `light` | 5 min | none | yes |
| `speedtest` | 60 min | real bandwidth | no |
| `quality` | 6 h | ~200 MB | no |

The expensive jobs deliberately do not run at load. Firing every probe in the
same second made three concurrent `system_profiler` calls return empty, and made
a fresh install immediately spend 200 MB on a test nobody asked for.

## Data

SQLite at `~/.8gent/starlink/monitor.db`. Logs at `~/.8gent/starlink/*.log`.
Nothing is seeded or mocked: an empty chart means it has not probed yet.

Everything stays on the machine. The server binds `127.0.0.1` only, there is no
telemetry, no account and no upload. The database and logs are not tracked by
this repository, and a checkout ships with no measurements in it.

## Licence

MIT. See [LICENSE](LICENSE).
