// A CORS proxy for weather downloads, as a Cloudflare Worker (the free tier is plenty).
//
// climate.onebuilding.org sends no Access-Control-Allow-Origin header, so a web page cannot
// download its weather files directly. Deploy this worker (paste it into the Cloudflare
// dashboard's editor, or `npx wrangler deploy proxy/weather-proxy.js --name cartes-weather`),
// then set cartes' weather proxy (Simulate → Find weather) to:
//
//   https://cartes-weather.<your-account>.workers.dev/?url={url}
//
// It forwards GET requests for climate.onebuilding.org files only, so it cannot be used as an
// open proxy. Set ALLOWED_ORIGIN to your cartes origin to refuse other pages.

const ALLOWED_HOST = 'climate.onebuilding.org'
const ALLOWED_ORIGIN = '*'

export default {
  async fetch(request) {
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    }
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors })
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: cors })

    let url
    try {
      url = new URL(new URL(request.url).searchParams.get('url') ?? '')
    } catch {
      return new Response('Pass the file to fetch as ?url=', { status: 400, headers: cors })
    }
    if (url.protocol !== 'https:' || url.hostname !== ALLOWED_HOST) {
      return new Response(`Only ${ALLOWED_HOST} files are proxied`, { status: 403, headers: cors })
    }

    const upstream = await fetch(url, { method: request.method, cf: { cacheTtl: 86400, cacheEverything: true } })
    const headers = new Headers(cors)
    for (const h of ['Content-Type', 'Content-Length', 'Last-Modified']) {
      const v = upstream.headers.get(h)
      if (v) headers.set(h, v)
    }
    return new Response(upstream.body, { status: upstream.status, headers })
  },
}
