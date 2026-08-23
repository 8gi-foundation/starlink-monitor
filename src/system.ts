/**
 * system.ts - the local half of the picture: Wi-Fi link quality, which
 * interface owns the default route, and whether a VPN is capturing traffic.
 *
 * The VPN check exists because it was the single largest measured degradation
 * on this machine: 11.1 Mbps through a NordLynx tunnel versus 26-76 Mbps
 * direct, with latency to 1.1.1.1 going from 162 ms to 54 ms once it was off.
 * That is worth surfacing every single time it happens.
 */

async function sh(cmd: string[], timeoutMs = 10_000): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" })
  const t = setTimeout(() => proc.kill(), timeoutMs)
  const out = await new Response(proc.stdout).text()
  await proc.exited
  clearTimeout(t)
  return out
}

export interface WifiInfo {
  ssidChannel?: number
  band?: string
  widthMhz?: number
  rssiDbm?: number
  noiseDbm?: number
  snrDb?: number
  txRateMbps?: number
  phyMode?: string
  security?: string
}

export async function getWifi(): Promise<WifiInfo> {
  // system_profiler returns empty when several probes invoke it in the same
  // instant, which happens whenever launchd fires jobs together at load. One
  // retry turns a silently-null row into a real reading.
  let out = await sh(["system_profiler", "SPAirPortDataType"], 15_000)
  if (!out.includes("Current Network Information")) {
    await Bun.sleep(1500)
    out = await sh(["system_profiler", "SPAirPortDataType"], 15_000)
  }
  const block = out.split("Current Network Information:")[1]?.split("Other Local")[0] ?? ""
  const grab = (re: RegExp): string | undefined => block.match(re)?.[1]?.trim()

  const chRaw = grab(/Channel:\s*(.+)/) // e.g. "48 (5GHz, 80MHz)"
  const sig = grab(/Signal \/ Noise:\s*(.+)/) // e.g. "-54 dBm / -94 dBm"

  const chNum = chRaw ? Number(chRaw.match(/^(\d+)/)?.[1]) : undefined
  const band = chRaw?.match(/(\d+GHz)/)?.[1]
  const width = chRaw ? Number(chRaw.match(/(\d+)MHz/)?.[1]) : undefined
  const rssi = sig ? Number(sig.match(/(-?\d+) dBm/)?.[1]) : undefined
  const noise = sig ? Number(sig.match(/\/\s*(-?\d+) dBm/)?.[1]) : undefined

  return {
    ssidChannel: chNum,
    band,
    widthMhz: width,
    rssiDbm: rssi,
    noiseDbm: noise,
    snrDb: rssi != null && noise != null ? rssi - noise : undefined,
    txRateMbps: Number(grab(/Transmit Rate:\s*(\d+)/)) || undefined,
    phyMode: grab(/PHY Mode:\s*(.+)/),
    security: grab(/Security:\s*(.+)/),
  }
}

export interface RouteInfo {
  iface?: string
  gateway?: string
  vpnActive: boolean
  vpnName?: string
}

/** utun with a default route means a full-tunnel VPN owns all traffic. */
export async function getRoute(): Promise<RouteInfo> {
  const out = await sh(["route", "-n", "get", "default"])
  const iface = out.match(/interface:\s*(\S+)/)?.[1]
  const gateway = out.match(/gateway:\s*(\S+)/)?.[1]
  const vpnActive = !!iface?.startsWith("utun")

  let vpnName: string | undefined
  if (vpnActive) {
    const nc = await sh(["scutil", "--nc", "list"])
    const connected = nc
      .split("\n")
      .filter((l) => l.includes("(Connected)"))
      .map((l) => l.match(/"([^"]+)"/)?.[1])
      .filter((n): n is string => !!n && !/tailscale/i.test(n))
    vpnName = connected[0]
    // Tailscale alone does not take the default route unless an exit node is
    // set, so a bare Tailscale connection is not reported as a degradation.
    if (!vpnName) return { iface, gateway, vpnActive: false }
  }
  return { iface, gateway, vpnActive, vpnName }
}

export interface LatencyInfo {
  routerMs?: number
  internetMs?: number
  lossPct?: number
}

export async function getLatency(): Promise<LatencyInfo> {
  const parse = (o: string) => {
    const avg = Number(o.match(/= [\d.]+\/([\d.]+)\//)?.[1])
    const loss = Number(o.match(/([\d.]+)% packet loss/)?.[1])
    return { avg: isNaN(avg) ? undefined : Math.round(avg * 10) / 10, loss }
  }
  const [r, i] = await Promise.all([
    sh(["ping", "-c", "3", "-t", "3", "192.168.1.1"]),
    sh(["ping", "-c", "5", "-t", "6", "1.1.1.1"]),
  ])
  const pr = parse(r)
  const pi = parse(i)
  return { routerMs: pr.avg, internetMs: pi.avg, lossPct: pi.loss }
}

export interface Bufferbloat {
  downMbps?: number
  upMbps?: number
  idleMs?: number
  loadedMs?: number
  idleRpm?: number
  loadedRpm?: number
  rating?: string
}

/**
 * Apple's networkQuality: a real 16-flow capacity test plus a responsiveness
 * score. Responsiveness is the number that actually predicts whether the
 * connection FEELS fast. It moves ~200 MB, so run it rarely.
 */
export async function runNetworkQuality(): Promise<Bufferbloat | null> {
  const out = await sh(["networkQuality", "-v"], 180_000)
  if (!out.trim()) return null
  const n = (re: RegExp) => {
    const v = Number(out.match(re)?.[1])
    return isNaN(v) ? undefined : Math.round(v * 10) / 10
  }
  const idleRpm = n(/Idle Latency:\s*\n\s*(\d+) RPM/)
  const loadedRpm = n(/Responsiveness:.*\n\s*(\d+) RPM/)
  const rating = out.match(/Responsiveness:\s*(\w+)/)?.[1]
  return {
    downMbps: n(/Downlink capacity:\s*([\d.]+) Mbps/),
    upMbps: n(/Uplink capacity:\s*([\d.]+) Mbps/),
    idleMs: n(/Idle Latency:\s*\n\s*\d+ RPM \(([\d.]+) milliseconds/),
    loadedMs: n(/Responsiveness:.*\n\s*\d+ RPM \(([\d.]+) milliseconds/),
    idleRpm,
    loadedRpm,
    rating,
  }
}
