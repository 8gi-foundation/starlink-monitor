/**
 * db.ts - local SQLite store. One row per probe, one row per alert.
 *
 * Everything is measured on this machine. Nothing is seeded, mocked, or
 * back-filled: an empty chart means we have not probed yet, and that is the
 * honest thing for it to show.
 */

import { Database } from "bun:sqlite"
import { mkdirSync } from "fs"
import { dirname } from "path"

const DB_PATH = `${process.env.HOME}/.8gent/starlink/monitor.db`

mkdirSync(dirname(DB_PATH), { recursive: true })

export const db = new Database(DB_PATH, { create: true })
db.exec("PRAGMA journal_mode = WAL;")

db.exec(`
CREATE TABLE IF NOT EXISTS probe (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                TEXT    NOT NULL,
  kind              TEXT    NOT NULL,          -- 'light' | 'speedtest' | 'quality'
  dish_reachable    INTEGER,
  pop_ping_ms       REAL,
  obstruction_pct   REAL,
  dish_alerts       TEXT,
  uptime_hours      REAL,
  hist_down_peak    REAL,
  hist_down_mean    REAL,
  hist_up_peak      REAL,
  hist_up_mean      REAL,
  hist_drop_pct     REAL,
  wifi_rssi         REAL,
  wifi_snr          REAL,
  wifi_channel      INTEGER,
  wifi_band         TEXT,
  wifi_tx_rate      REAL,
  wifi_phy          TEXT,
  route_iface       TEXT,
  vpn_active        INTEGER,
  vpn_name          TEXT,
  latency_router_ms REAL,
  latency_inet_ms   REAL,
  loss_pct          REAL,
  st_down_median    REAL,
  st_down_peak      REAL,
  st_up_median      REAL,
  st_up_peak        REAL,
  nq_down_mbps      REAL,
  nq_up_mbps        REAL,
  nq_idle_ms        REAL,
  nq_loaded_ms      REAL,
  nq_rating         TEXT
);
CREATE INDEX IF NOT EXISTS probe_ts ON probe(ts);
CREATE INDEX IF NOT EXISTS probe_kind ON probe(kind);

CREATE TABLE IF NOT EXISTS alert (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT    NOT NULL,
  code       TEXT    NOT NULL,
  severity   TEXT    NOT NULL,                 -- 'info' | 'warn' | 'critical'
  message    TEXT    NOT NULL,
  fix        TEXT,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS alert_ts ON alert(ts);
CREATE INDEX IF NOT EXISTS alert_open ON alert(code, resolved_at);
`)

export type ProbeRow = Record<string, any>

export function insertProbe(row: ProbeRow): void {
  const cols = Object.keys(row)
  const stmt = db.prepare(
    `INSERT INTO probe (${cols.join(",")}) VALUES (${cols.map((c) => `$${c}`).join(",")})`
  )
  const bound: Record<string, any> = {}
  for (const c of cols) {
    const v = row[c]
    bound[`$${c}`] = typeof v === "boolean" ? (v ? 1 : 0) : v === undefined ? null : v
  }
  stmt.run(bound)
}

export interface AlertSpec {
  code: string
  severity: "info" | "warn" | "critical"
  message: string
  fix?: string
}

/**
 * Alerts are stateful: raising the same code twice does not create a second
 * row, and it auto-resolves when the condition clears. Without this the menu
 * bar would show the same complaint a hundred times a day and get ignored.
 */
export function raiseAlert(a: AlertSpec): boolean {
  const open = db
    .query("SELECT id FROM alert WHERE code = ? AND resolved_at IS NULL LIMIT 1")
    .get(a.code) as { id: number } | null
  if (open) return false
  db.prepare(
    "INSERT INTO alert (ts, code, severity, message, fix) VALUES (?, ?, ?, ?, ?)"
  ).run(new Date().toISOString(), a.code, a.severity, a.message, a.fix ?? null)
  return true
}

export function resolveAlert(code: string): void {
  db.prepare(
    "UPDATE alert SET resolved_at = ? WHERE code = ? AND resolved_at IS NULL"
  ).run(new Date().toISOString(), code)
}

export function openAlerts(): any[] {
  return db
    .query("SELECT * FROM alert WHERE resolved_at IS NULL ORDER BY ts DESC")
    .all() as any[]
}

export function latestProbe(kind?: string): any {
  return kind
    ? db.query("SELECT * FROM probe WHERE kind = ? ORDER BY id DESC LIMIT 1").get(kind)
    : db.query("SELECT * FROM probe ORDER BY id DESC LIMIT 1").get()
}

export function history(hours = 24): any[] {
  const since = new Date(Date.now() - hours * 3600_000).toISOString()
  return db
    .query("SELECT * FROM probe WHERE ts > ? ORDER BY ts ASC")
    .all(since) as any[]
}

/** Median speedtest downlink bucketed by local hour, for the "best hours" view. */
export function byHour(days = 7): any[] {
  const since = new Date(Date.now() - days * 86400_000).toISOString()
  return db
    .query(
      `SELECT CAST(strftime('%H', ts, 'localtime') AS INTEGER) AS hour,
              COUNT(*) AS n,
              AVG(st_down_median) AS avg_down,
              AVG(st_up_median)   AS avg_up
       FROM probe
       WHERE ts > ? AND st_down_median IS NOT NULL
       GROUP BY hour ORDER BY hour`
    )
    .all(since) as any[]
}
