#!/usr/bin/env bun
/**
 * probe.ts - one scheduled measurement, then exit. Driven by launchd.
 *
 *   bun run src/probe.ts light      every 5 min   cheap, no bandwidth used
 *   bun run src/probe.ts speedtest  every 60 min  Starlink's own dish->PoP test
 *   bun run src/probe.ts quality    every 6 h     networkQuality, ~200 MB
 *
 * The split matters: a speed test that runs every five minutes would itself
 * become the congestion it is trying to measure.
 *
 * On thresholds: these are calibrated against what this line actually did on
 * 13 Aug 2026, not against Starlink's marketing. Baseline measured that day
 * was 374 Mbps median down / 14.4 Mbps up dish-to-PoP, 24 ms to PoP, 40 dB
 * Wi-Fi SNR. Alerts fire on departures from that, so they mean something.
 */

import { getStatus, getHistory, runSpeedTest } from "./starlink"
import { getWifi, getRoute, getLatency, runNetworkQuality } from "./system"
import { insertProbe, raiseAlert, resolveAlert } from "./db"
import { notify } from "./notify"

const MODE = (process.argv[2] ?? "light") as "light" | "speedtest" | "quality"

// --- thresholds, all derived from measured baseline ------------------------
const T = {
  popPingMs: 80,        // measured 24 ms; 80 means the path is genuinely unwell
  obstructionPct: 0.5,  // measured 0 over a 54 h window
  wifiRssi: -70,        // measured -54; -70 is where 802.11ax rates start folding
  wifiSnr: 25,          // measured 40 dB
  lossPct: 5,
  speedDownMbps: 100,   // measured 374 median; 100 means the cell is congested
  speedUpMbps: 8,       // measured 14.4 median
  loadedMs: 250,        // measured 189-299 under load; this is the bufferbloat line
}

async function main(): Promise<void> {
  const ts = new Date().toISOString()
  const row: Record<string, any> = { ts, kind: MODE }

  const [status, hist, wifi, route, lat] = await Promise.all([
    getStatus(),
    getHistory(300),
    getWifi(),
    getRoute(),
    getLatency(),
  ])

  row.dish_reachable = status.reachable
  row.pop_ping_ms = status.popPingMs ?? null
  row.obstruction_pct = status.fractionObstructed != null ? status.fractionObstructed * 100 : null
  row.dish_alerts = status.alerts.length ? JSON.stringify(status.alerts) : null
  row.uptime_hours = status.uptimeHours ?? null

  row.hist_down_peak = hist?.downPeakMbps ?? null
  row.hist_down_mean = hist?.downMeanMbps ?? null
  row.hist_up_peak = hist?.upPeakMbps ?? null
  row.hist_up_mean = hist?.upMeanMbps ?? null
  row.hist_drop_pct = hist?.dropRatePct ?? null

  row.wifi_rssi = wifi.rssiDbm ?? null
  row.wifi_snr = wifi.snrDb ?? null
  row.wifi_channel = wifi.ssidChannel ?? null
  row.wifi_band = wifi.band ?? null
  row.wifi_tx_rate = wifi.txRateMbps ?? null
  row.wifi_phy = wifi.phyMode ?? null

  row.route_iface = route.iface ?? null
  row.vpn_active = route.vpnActive
  row.vpn_name = route.vpnName ?? null

  row.latency_router_ms = lat.routerMs ?? null
  row.latency_inet_ms = lat.internetMs ?? null
  row.loss_pct = lat.lossPct ?? null

  // ---------------- expensive probes, only on their schedule ---------------
  if (MODE === "speedtest") {
    const st = await runSpeedTest()
    if (st) {
      row.st_down_median = st.downMedianMbps
      row.st_down_peak = st.downPeakMbps
      row.st_up_median = st.upMedianMbps
      row.st_up_peak = st.upPeakMbps
    }
  }

  if (MODE === "quality") {
    const nq = await runNetworkQuality()
    if (nq) {
      row.nq_down_mbps = nq.downMbps ?? null
      row.nq_up_mbps = nq.upMbps ?? null
      row.nq_idle_ms = nq.idleMs ?? null
      row.nq_loaded_ms = nq.loadedMs ?? null
      row.nq_rating = nq.rating ?? null
    }
  }

  insertProbe(row)
  evaluate(row, status, route)
}

/**
 * Turn measurements into a small number of alerts a human would act on.
 * Each one carries a concrete fix, because an alert you cannot act on is noise.
 */
function evaluate(row: Record<string, any>, status: any, route: any): void {
  const fire = (a: Parameters<typeof raiseAlert>[0]) => {
    if (raiseAlert(a)) notify(a.message, a.fix)
  }

  // --- the one degradation that is genuinely yours to fix -----------------
  if (route.vpnActive) {
    fire({
      code: "vpn_full_tunnel",
      severity: "warn",
      message: `${route.vpnName ?? "A VPN"} is carrying all traffic`,
      fix: "Measured cost on this line: 11 Mbps tunnelled vs 26-76 direct. Disconnect it, or move to an Ireland exit server.",
    })
  } else {
    resolveAlert("vpn_full_tunnel")
  }

  if (!status.reachable) {
    fire({
      code: "dish_unreachable",
      severity: "warn",
      message: "Cannot reach the dish at 192.168.100.1",
      fix: "Usually a VPN kill switch eating the LAN route rather than a dish fault. Check the VPN first.",
    })
  } else {
    resolveAlert("dish_unreachable")
  }

  if (status.alerts?.length) {
    fire({
      code: "dish_alert",
      severity: "critical",
      message: `Dish reports: ${status.alerts.join(", ")}`,
      fix: "Check the Starlink app for detail. Thermal and actuator alerts need physical attention.",
    })
  } else {
    resolveAlert("dish_alert")
  }

  if (row.obstruction_pct != null && row.obstruction_pct > T.obstructionPct) {
    fire({
      code: "obstruction",
      severity: "warn",
      message: `Sky obstructed ${row.obstruction_pct.toFixed(2)}% of the time`,
      fix: "Baseline for this dish is 0% over 54 hours. Something new is blocking the view.",
    })
  } else {
    resolveAlert("obstruction")
  }

  if (row.pop_ping_ms != null && row.pop_ping_ms > T.popPingMs) {
    fire({
      code: "pop_latency",
      severity: "warn",
      message: `PoP latency ${row.pop_ping_ms} ms (baseline 24 ms)`,
      fix: "Usually cell congestion. Check the by-hour view for a better window.",
    })
  } else {
    resolveAlert("pop_latency")
  }

  if (row.wifi_rssi != null && row.wifi_rssi < T.wifiRssi) {
    fire({
      code: "wifi_weak",
      severity: "warn",
      message: `Wi-Fi signal ${row.wifi_rssi} dBm (baseline -54)`,
      fix: "Move closer to the router, or check what changed. 802.11ax rates fold below -70.",
    })
  } else {
    resolveAlert("wifi_weak")
  }

  if (row.st_down_median != null && row.st_down_median < T.speedDownMbps) {
    fire({
      code: "cell_congested",
      severity: "info",
      message: `Line delivering ${row.st_down_median} Mbps (baseline 374)`,
      fix: "Starlink cell congestion. Nothing local to fix. The by-hour chart shows when it clears.",
    })
  } else if (row.st_down_median != null) {
    resolveAlert("cell_congested")
  }

  if (row.nq_loaded_ms != null && row.nq_loaded_ms > T.loadedMs) {
    fire({
      code: "bufferbloat",
      severity: "info",
      message: `Latency under load ${row.nq_loaded_ms} ms`,
      fix: "This is why it feels slow even at good Mbps. Fixing it needs a router with SQM; the Starlink router has no such control.",
    })
  } else if (row.nq_loaded_ms != null) {
    resolveAlert("bufferbloat")
  }
}

await main()
