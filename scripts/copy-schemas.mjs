// Copy the EnergyPlus schema bundle (@idfkit/schemas, ~1.2 MB gzipped) to public/schemas/, where
// the browser fetches it on demand. Run by `predev` and `prebuild`.
import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const data = dirname(require.resolve('@idfkit/schemas/data/index.json.gz'))
const target = join(import.meta.dirname, '..', 'public', 'schemas')
mkdirSync(target, { recursive: true })
cpSync(data, target, { recursive: true })
console.log(`copy-schemas: ${data} -> public/schemas`)
