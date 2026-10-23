// Copy data the browser fetches on demand into public/ (gitignored). Run by `predev` and `prebuild`.
// - public/schemas/: the EnergyPlus schema bundle (@idfkit/schemas, ~1.2 MB gzipped).
// - public/weather/: the TMYx weather-station index (@idfkit/weather, ~1.7 MB gzipped).
import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const publicDir = join(import.meta.dirname, '..', 'public')

const schemas = dirname(require.resolve('@idfkit/schemas/data/index.json.gz'))
mkdirSync(join(publicDir, 'schemas'), { recursive: true })
cpSync(schemas, join(publicDir, 'schemas'), { recursive: true })

const stations = require.resolve('@idfkit/weather/data/stations.json.gz')
mkdirSync(join(publicDir, 'weather'), { recursive: true })
cpSync(stations, join(publicDir, 'weather', 'stations.json.gz'))

console.log('copy-data: schemas -> public/schemas, weather stations -> public/weather')
