#!/usr/bin/env bun
/**
 * server.ts - local HTTP API + dashboard. Bound to 127.0.0.1 only.
 *
 * The menu bar app polls /api/status for its one-line summary; the dashboard
 * uses the richer endpoints. Nothing here listens on a routable interface and
 * nothing leaves the machine.
 */

import { latestProbe, openAlerts, history, byHour, resolveAlert, db } from "./db"
import { getRoute, getWifi } from "./system"
import { runSpeedTest, reboot } from "./starlink"

const PORT = Number(process.env.STARLINK_PORT ?? 8787)
const DASH = new URL("./dashboard.html", import.meta.url).pathname

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })

/** Compact summary the menu bar renders. Must stay cheap: polled every 15s. */
async function summary() {
  const light = latestProbe("light") ?? latestProbe()
  const st = db
    .query("SELECT * FROM probe WHERE st_down_median IS NOT NULL ORDER BY id DESC LIMIT 1")
    .get() as any
  const nq = db
    .query("SELECT * FROM probe WHERE nq_loaded_ms IS NOT NULL ORDER BY id DESC LIMIT 1")
    .get() as any
  const alerts = openAlerts()
  const route = await getRoute()

  // Worst open severity drives the menu bar colour and the header chip.
  // `ok` MUST carry rank 0: without it every comparison against undefined is
  // false, and the header cheerfully reads "all clear" with alerts on screen.
  const rank: Record<string, number> = { ok: 0, info: 1, warn: 2, critical: 3 }
  const worst = alerts.reduce(
    (m, a) => ((rank[a.severity] ?? 0) > (rank[m] ?? 0) ? a.severity : m),
    "ok"
  )

  return {
    ts: light?.ts ?? null,
    state: alerts.length === 0 ? "ok" : worst,
    lineDownMbps: st?.st_down_median ?? null,
    lineUpMbps: st?.st_up_median ?? null,
    lineTestedAt: st?.ts ?? null,
    popPingMs: light?.pop_ping_ms ?? null,
    wifiRssi: light?.wifi_rssi ?? null,
    wifiSnr: light?.wifi_snr ?? null,
    loadedMs: nq?.nq_loaded_ms ?? null,
    responsiveness: nq?.nq_rating ?? null,
    vpnActive: route.vpnActive,
    vpnName: route.vpnName ?? null,
    dishReachable: light?.dish_reachable === 1,
    alerts: alerts.map((a) => ({
      code: a.code,
      severity: a.severity,
      message: a.message,
      fix: a.fix,
      ts: a.ts,
    })),
  }
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url)
    const p = url.pathname

    if (p === "/" || p === "/index.html") {
      return new Response(Bun.file(DASH), { headers: { "content-type": "text/html" } })
    }

    if (p === "/api/status") return json(await summary())

    if (p === "/api/history") {
      const hours = Number(url.searchParams.get("hours") ?? 24)
      return json(history(hours))
    }

    if (p === "/api/byhour") {
      const days = Number(url.searchParams.get("days") ?? 7)
      return json(byHour(days))
    }

    // --- actions ---------------------------------------------------------
    if (p === "/api/speedtest" && req.method === "POST") {
      const r = await runSpeedTest()
      return r ? json(r) : json({ error: "speed test did not complete" }, 503)
    }

    if (p === "/api/dismiss" && req.method === "POST") {
      const { code } = (await req.json()) as { code: string }
      resolveAlert(code)
      return json({ ok: true })
    }

    // Reboot is destructive: it drops the whole house offline for ~2 minutes.
    // It is exposed but never automatic, and requires an explicit confirm token
    // so a stray fetch cannot trigger it.
    if (p === "/api/reboot" && req.method === "POST") {
      const { confirm } = (await req.json()) as { confirm?: string }
      if (confirm !== "REBOOT") return json({ error: "confirmation required" }, 400)
      const ok = await reboot()
      return json({ ok })
    }

    return new Response("not found", { status: 404 })
  },
})

console.log(`starlink-monitor dashboard: http://127.0.0.1:${PORT}`)
