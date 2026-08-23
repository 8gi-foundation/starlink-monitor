/**
 * starlink.ts - talk to the dish and router over their local gRPC endpoints.
 *
 * The dish answers on 192.168.100.1:9200, the router on 192.168.1.1:9000.
 * Both speak SpaceX.API.Device.Device/Handle with server reflection enabled,
 * so grpcurl needs no .proto files. We shell out to grpcurl rather than
 * vendoring a gRPC stack: one binary, zero dependencies, trivially debuggable.
 *
 * NOTE ON THE HISTORY RING BUFFER (this cost us two wrong readings):
 * dishGetHistory returns fixed-size arrays that are a RING buffer, plus a
 * `current` counter that keeps incrementing forever. The newest sample lives at
 * (current - 1) % length, NOT at the end of the array. Slicing the tail reads
 * an arbitrary window of history. Always unwrap via `current`.
 */

const DISH = "192.168.100.1:9200"
const ROUTER = "192.168.1.1:9000"

export interface DishStatus {
  reachable: boolean
  hardware?: string
  software?: string
  uptimeHours?: number
  popPingMs?: number
  downlinkMbps?: number
  uplinkMbps?: number
  obstructedNow?: boolean
  fractionObstructed?: number
  alerts: string[]
  error?: string
}

export interface DishHistory {
  downPeakMbps: number
  downMeanMbps: number
  upPeakMbps: number
  upMeanMbps: number
  pingMeanMs: number
  dropRatePct: number
  samples: number
}

export interface SpeedTestResult {
  downMedianMbps: number
  downPeakMbps: number
  upMedianMbps: number
  upPeakMbps: number
  samples: number
}

async function grpc(target: string, payload: object, timeoutMs = 20_000): Promise<any> {
  const proc = Bun.spawn(
    [
      "grpcurl",
      "-plaintext",
      "-max-time",
      String(Math.ceil(timeoutMs / 1000)),
      "-d",
      JSON.stringify(payload),
      target,
      "SpaceX.API.Device.Device/Handle",
    ],
    { stdout: "pipe", stderr: "pipe" }
  )
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  await proc.exited
  if (!out.trim()) throw new Error(err.trim() || "empty response")
  return JSON.parse(out)
}

const num = (v: unknown): number => (v == null ? 0 : Number(v) || 0)

export async function getStatus(): Promise<DishStatus> {
  try {
    const r = await grpc(DISH, { get_status: {} }, 12_000)
    const d = r.dishGetStatus ?? {}
    const o = d.obstructionStats ?? {}
    const alertObj = d.alerts ?? {}
    // alerts arrive as {name: true} for whatever is firing; absent means clear
    const alerts = Object.entries(alertObj)
      .filter(([, v]) => v === true)
      .map(([k]) => k)
    return {
      reachable: true,
      hardware: d.deviceInfo?.hardwareVersion,
      software: d.deviceInfo?.softwareVersion,
      uptimeHours: Math.round((num(d.deviceState?.uptimeS) / 3600) * 10) / 10,
      popPingMs: Math.round(num(d.popPingLatencyMs) * 10) / 10,
      downlinkMbps: Math.round((num(d.downlinkThroughputBps) / 1e6) * 10) / 10,
      uplinkMbps: Math.round((num(d.uplinkThroughputBps) / 1e6) * 10) / 10,
      obstructedNow: o.currentlyObstructed === true,
      fractionObstructed: num(o.fractionObstructed),
      alerts,
    }
  } catch (e: any) {
    // Unreachable almost always means a VPN kill switch is eating the LAN route,
    // not that the dish is down. The probe records the distinction.
    return { reachable: false, alerts: [], error: String(e?.message ?? e).slice(0, 200) }
  }
}

export async function getHistory(seconds = 300): Promise<DishHistory | null> {
  try {
    const r = await grpc(DISH, { get_history: {} }, 15_000)
    const h = r.dishGetHistory ?? {}
    const cur = Number(h.current ?? 0)
    const dl = (h.downlinkThroughputBps ?? []).map(num)
    const ul = (h.uplinkThroughputBps ?? []).map(num)
    const pg = (h.popPingLatencyMs ?? []).map(num)
    const dr = (h.popPingDropRate ?? []).map(num)
    const n = dl.length
    if (!n) return null

    // unwrap the ring: newest first, walking backwards from current-1
    const recent = (arr: number[], k: number): number[] => {
      const len = arr.length
      if (!len) return []
      const take = Math.min(k, len)
      return Array.from({ length: take }, (_, i) => arr[(cur - 1 - i + len * 2) % len] ?? 0)
    }

    const rd = recent(dl, seconds)
    const ru = recent(ul, seconds)
    const rp = recent(pg, seconds).filter((v) => v > 0)
    const rr = recent(dr, seconds)
    const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)

    return {
      downPeakMbps: Math.round((Math.max(...rd, 0) / 1e6) * 10) / 10,
      downMeanMbps: Math.round((mean(rd) / 1e6) * 10) / 10,
      upPeakMbps: Math.round((Math.max(...ru, 0) / 1e6) * 10) / 10,
      upMeanMbps: Math.round((mean(ru) / 1e6) * 10) / 10,
      pingMeanMs: Math.round(mean(rp) * 10) / 10,
      dropRatePct: Math.round(mean(rr) * 1000) / 10,
      samples: rd.length,
    }
  } catch {
    return null
  }
}

/**
 * Runs Starlink's OWN speed test: dish to PoP, bypassing Wi-Fi and this Mac
 * entirely. This is the only honest measure of what the line can deliver.
 * Takes roughly 30s and consumes real bandwidth, so schedule it sparingly.
 */
export async function runSpeedTest(): Promise<SpeedTestResult | null> {
  try {
    await grpc(ROUTER, { start_speedtest: {} }, 15_000)
  } catch {
    return null
  }

  for (let i = 0; i < 12; i++) {
    await Bun.sleep(5000)
    try {
      const r = await grpc(ROUTER, { get_speedtest_status: {} }, 10_000)
      // Shape is {getSpeedtestStatus: {status: {running, id, down:{throughputsMbps}, up:{...}}}}.
      // The samples live under `status`, NOT on the response root. Reading the
      // root silently yields undefined forever and the poll never completes.
      const outer = r.getSpeedtestStatus ?? {}
      const s = outer.status ?? outer
      const down: number[] = (s.down?.throughputsMbps ?? []).map(num)
      const up: number[] = (s.up?.throughputsMbps ?? []).map(num)
      // `running` is simply absent once the test finishes.
      const running = s.running === true
      if (!running && down.length > 10) {
        const med = (a: number[]) => {
          const x = [...a].sort((p, q) => p - q)
          return x.length ? Math.round(x[Math.floor(x.length / 2)] * 10) / 10 : 0
        }
        return {
          downMedianMbps: med(down),
          downPeakMbps: Math.round(Math.max(...down, 0) * 10) / 10,
          upMedianMbps: med(up),
          upPeakMbps: Math.round(Math.max(...up, 0) * 10) / 10,
          samples: down.length,
        }
      }
    } catch {
      /* keep polling */
    }
  }
  return null
}

export async function reboot(): Promise<boolean> {
  try {
    await grpc(ROUTER, { reboot: {} }, 10_000)
    return true
  } catch {
    return false
  }
}
