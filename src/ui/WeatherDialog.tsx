/**
 * Find weather: search the TMYx station index by place or near the model's Site:Location, pick
 * a station and load its EPW as the Simulate tab's weather. Downloads need a CORS proxy (see
 * src/weather/index.ts); without one the dialog offers the file's link to download by hand.
 */
import { useEffect, useRef, useState } from 'react'
import { searchStations, type StationSummary } from '../weather/index.js'

interface Props {
  /** The model's Site:Location, for "Near the model". */
  site: { latitude: number; longitude: number; name: string } | undefined
  proxy: string
  onProxyChange: (proxy: string) => void
  /** Download a station and use it; rejects with a message to show. */
  onUse: (station: StationSummary) => Promise<void>
  onClose: () => void
}

export function WeatherDialog({ site, proxy, onProxyChange, onUse, onClose }: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<StationSummary[] | undefined>(undefined)
  const [chosen, setChosen] = useState<StationSummary | undefined>(undefined)
  const [busy, setBusy] = useState<'search' | 'download' | undefined>(undefined)
  const [error, setError] = useState<{ text: string; url?: string } | undefined>(undefined)
  const input = useRef<HTMLInputElement | null>(null)

  useEffect(() => input.current?.focus(), [])

  const search = async (near: boolean): Promise<void> => {
    setBusy('search')
    setError(undefined)
    try {
      const found = await searchStations(near && site ? { latitude: site.latitude, longitude: site.longitude, limit: 12 } : { query, limit: 12 })
      setResults(found)
      setChosen(found[0])
    } catch (e) {
      setError({ text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(undefined)
    }
  }

  const use = async (): Promise<void> => {
    if (!chosen) return
    setBusy('download')
    setError(undefined)
    try {
      await onUse(chosen)
      onClose()
    } catch (e) {
      setError({ text: e instanceof Error ? e.message : String(e), url: chosen.url })
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div
      className="dialog-backdrop"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="dialog weather-dialog" role="dialog" aria-label="Find weather">
        <h2 className="dialog__title">Find weather</h2>
        <p className="dialog__line">TMYx weather files from climate.onebuilding.org: about 69,000 stations worldwide.</p>
        <form
          className="weather-dialog__search"
          onSubmit={(e) => {
            e.preventDefault()
            void search(false)
          }}
        >
          <input
            ref={input}
            type="search"
            placeholder="City, airport, WMO number or file name"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit" disabled={!query.trim() || busy !== undefined}>
            Search
          </button>
          <button
            type="button"
            onClick={() => void search(true)}
            disabled={!site || busy !== undefined}
            title={site ? `Stations nearest ${site.name} (${site.latitude}, ${site.longitude})` : 'The model has no Site:Location'}
          >
            Near the model
          </button>
        </form>

        <div className="weather-dialog__results" role="listbox" aria-label="Stations">
          {busy === 'search' && <div className="weather-dialog__empty">Searching…</div>}
          {results?.length === 0 && <div className="weather-dialog__empty">No stations found.</div>}
          {results?.map((s) => (
            <button
              key={s.id}
              type="button"
              role="option"
              aria-selected={chosen?.id === s.id}
              className={`weather-dialog__station${chosen?.id === s.id ? ' weather-dialog__station--chosen' : ''}`}
              onClick={() => setChosen(s)}
              onDoubleClick={() => {
                setChosen(s)
                void use()
              }}
            >
              <span className="weather-dialog__name">
                {s.name}
                {s.distanceKm !== undefined && <span className="weather-dialog__distance"> · {s.distanceKm} km</span>}
              </span>
              <span className="weather-dialog__meta">
                {s.climateZone || 'Climate zone unknown'} · HDD18 {Math.round(s.hdd18)} · CDD10 {Math.round(s.cdd10)} · design{' '}
                {s.heatingDesignDbC} / {s.coolingDesignDbC} °C
              </span>
              <span className="weather-dialog__file">{s.id}</span>
            </button>
          ))}
        </div>

        <label className="dialog__field">
          Weather proxy
          <input
            type="url"
            placeholder="https://your-proxy.example.workers.dev/?url={url}"
            value={proxy}
            onChange={(e) => onProxyChange(e.target.value)}
            spellCheck={false}
          />
          <span className="dialog__hint">
            climate.onebuilding.org does not allow downloads from web pages. A proxy URL fetches for this page: {'{url}'} is
            replaced by the file’s address, or it is appended. proxy/weather-proxy.js in the repository is one to deploy.
          </span>
        </label>

        {error && (
          <div className="weather-dialog__error">
            {error.text}
            {error.url && (
              <>
                {' '}
                <a href={error.url} target="_blank" rel="noreferrer">
                  Download link
                </a>
              </>
            )}
          </div>
        )}

        <div className="dialog__actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button--active" onClick={() => void use()} disabled={!chosen || busy !== undefined}>
            {busy === 'download' ? 'Downloading…' : 'Use weather'}
          </button>
        </div>
      </div>
    </div>
  )
}
