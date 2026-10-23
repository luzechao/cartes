/**
 * Weather files: search the climate.onebuilding.org TMYx station index and download a station's
 * EPW and DDY, through `@idfkit/weather`.
 *
 * The index (~1.7 MB gzipped, 69,000 entries) is served from this site — `public/weather/`,
 * copied by `scripts/copy-data.mjs` — so search works offline. Downloads are another matter:
 * climate.onebuilding.org sends no CORS header, so a page cannot fetch from it directly. They go
 * through a proxy the user configures (any URL that forwards a request, e.g. a Cloudflare Worker;
 * see `proxy/weather-proxy.js`); without one the error names the file to download by hand.
 */
import { fetchWeatherFiles, loadStationIndex, type StationIndex, type WeatherStation } from '@idfkit/weather'

export class WeatherError extends Error {}

let index: Promise<StationIndex> | undefined

/** Use this index loader instead — in Node, `loadBundledIndex` from `@idfkit/weather/node`. */
export function setStationIndexLoader(load: () => Promise<StationIndex>): void {
  index = load()
}

export function stationIndex(): Promise<StationIndex> {
  index ??= loadStationIndex(new URL(`${import.meta.env?.BASE_URL ?? '/'}weather/stations.json.gz`, globalThis.location?.href)).catch(
    (error: unknown) => {
      index = undefined
      throw error
    },
  )
  return index
}

export interface StationSummary {
  /** The file name without extension; pass it to download. */
  id: string
  name: string
  country: string
  state: string
  wmo: string
  latitude: number
  longitude: number
  elevation: number
  timeZone: number
  climateZone: string
  /** Heating degree-days base 18 °C, cooling degree-days base 10 °C. */
  hdd18: number
  cdd10: number
  heatingDesignDbC: number
  coolingDesignDbC: number
  distanceKm?: number
  /** The ZIP on climate.onebuilding.org, for downloading by hand. */
  url: string
  /** Other year ranges of the same station. */
  otherVariants?: string[]
}

/** `USA_IL_Chicago.OHare.Intl.AP.725300` for every TMYx variant of that station. */
function stationKey(s: WeatherStation): string {
  return s.filenameStem.slice(0, s.filenameStem.length - s.datasetVariant.length).replace(/_$/, '')
}

/** The newest year range wins: `TMYx.2011-2025` over `TMYx.2009-2023`; a range over the undated `TMYx`. */
function variantRank(s: WeatherStation): number {
  const m = /(\d{4})-(\d{4})$/.exec(s.datasetVariant)
  return m ? Number(m[2]) : 0
}

function summarize(s: WeatherStation, variants: WeatherStation[], distanceKm?: number): StationSummary {
  const out: StationSummary = {
    id: s.filenameStem,
    name: s.displayName,
    country: s.country,
    state: s.state,
    wmo: s.wmo,
    latitude: s.latitude,
    longitude: s.longitude,
    elevation: s.elevation,
    timeZone: s.timezone,
    climateZone: s.ashraeClimateZone,
    hdd18: s.hdd18,
    cdd10: s.cdd10,
    heatingDesignDbC: s.heatingDesignDbC,
    coolingDesignDbC: s.coolingDesignDbC,
    url: s.url,
  }
  if (distanceKm !== undefined) out.distanceKm = Math.round(distanceKm * 10) / 10
  const others = variants.filter((v) => v !== s).map((v) => v.filenameStem)
  if (others.length) out.otherVariants = others
  return out
}

/** Group variants by station, best first within each, preserving the order stations first appear. */
function grouped<T>(hits: T[], station: (hit: T) => WeatherStation): Array<{ hit: T; variants: WeatherStation[] }> {
  const groups = new Map<string, { hit: T; variants: WeatherStation[] }>()
  for (const hit of hits) {
    const s = station(hit)
    const key = stationKey(s)
    const g = groups.get(key)
    if (!g) groups.set(key, { hit, variants: [s] })
    else g.variants.push(s)
  }
  for (const g of groups.values()) g.variants.sort((a, b) => variantRank(b) - variantRank(a))
  return [...groups.values()]
}

/**
 * Stations by name, city, state, WMO number or file name; or nearest a point. Each station is
 * listed once, as its newest TMYx variant, with the others named.
 */
export async function searchStations(args: {
  query?: string | undefined
  latitude?: number | undefined
  longitude?: number | undefined
  country?: string | undefined
  limit?: number | undefined
}): Promise<StationSummary[]> {
  const idx = await stationIndex()
  const limit = Math.min(Math.max(args.limit ?? 8, 1), 30)
  if (args.latitude !== undefined && args.longitude !== undefined && !args.query) {
    const near = idx.nearest(args.latitude, args.longitude, { limit: limit * 6, ...(args.country ? { country: args.country } : {}) })
    return grouped(near, (r) => r.station)
      .slice(0, limit)
      .map((g) => summarize(g.variants[0]!, g.variants, g.hit.distanceKm))
  }
  const query = (args.query ?? '').trim()
  if (!query) throw new WeatherError('Give a place to search for, or a latitude and longitude.')
  const hits = idx.search(query, { limit: 300, ...(args.country ? { country: args.country } : {}) })
  const first = query.toLowerCase().split(/[\s,]+/)[0] ?? ''
  // A city that starts with the query ("Chicago OHare") before one that merely contains it ("Port Chicago").
  const score = (r: (typeof hits)[number]): number => r.score + (r.station.city.toLowerCase().startsWith(first) ? 0.1 : 0)
  const ranked = [...hits].sort((a, b) => score(b) - score(a))
  return grouped(ranked, (r) => r.station)
    .slice(0, limit)
    .map((g) => summarize(g.variants[0]!, g.variants))
}

export interface DownloadedWeather {
  station: StationSummary
  epw: File
  /** The design-day file's text, when the archive has one. */
  ddy: string | null
}

/**
 * Turn a proxy setting into a URL rewrite: `{url}` is replaced by the encoded upstream URL;
 * otherwise the upstream URL is appended.
 */
export function proxied(proxy: string | undefined): ((url: string) => string) | undefined {
  const p = proxy?.trim()
  if (!p) return undefined
  return (url) => (p.includes('{url}') ? p.replace('{url}', encodeURIComponent(url)) : p + url)
}

/** Download a station's EPW (and DDY) by its id, through `proxy` when given. */
export async function downloadWeather(id: string, proxy?: string, signal?: AbortSignal): Promise<DownloadedWeather> {
  const idx = await stationIndex()
  const variants = idx.getByFilename(id.trim().replace(/\.(epw|zip)$/i, ''))
  const station = variants.find((s) => s.filenameStem.toLowerCase() === id.trim().toLowerCase()) ?? variants[0]
  if (!station) throw new WeatherError(`No weather station '${id}'; search for it first.`)
  const rewriteUrl = proxied(proxy)
  try {
    const files = await fetchWeatherFiles(station, { ...(rewriteUrl ? { rewriteUrl } : {}), ...(signal ? { signal } : {}) })
    return {
      station: summarize(station, [station]),
      epw: new File([files.epw], `${station.filenameStem}.epw`, { type: 'text/plain' }),
      ddy: files.ddy,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new WeatherError(
      rewriteUrl
        ? `Could not download ${station.url} through the weather proxy: ${reason}`
        : `Could not download ${station.url} (${reason}). climate.onebuilding.org does not allow downloads from web pages; ` +
            'set a weather proxy in Simulate → Find weather, or download the ZIP yourself and load its EPW with Weather.',
    )
  }
}

/** Names of a DDY file's annual design days (the monthly ones are left out). */
export function designDayNames(ddy: string): string[] {
  return [...ddy.matchAll(/SizingPeriod:DesignDay,\s*\n\s*([^,]+),/g)].map((m) => m[1]!.trim()).filter((n) => / Ann /.test(n))
}
