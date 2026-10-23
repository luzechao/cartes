/**
 * Declarative Property Inspector — Phase 5 of docs/05-implementation-plan.md.
 *
 * Driven by the IDD field table from src/model/idd.ts and, for every class that table does not
 * carry, by the full EnergyPlus schema (src/schema/) once it has loaded: field names, units,
 * choices, defaults, notes, value checks and name suggestions for reference fields.
 */
import { useMemo } from 'react'
import { docsUrlForObject } from '@idfkit/core'
import type { IdfDocument } from '../parser/types.js'
import type { Model } from '../model/index.js'
import { getSchema, fieldNameAt, fieldSpecAt } from '../model/idd.js'
import { displayName, slotAt, valueProblem, type ProsePool, type Schema } from '../schema/index.js'

export interface FullSchema {
  schema: Schema
  prose?: ProsePool | undefined
}

interface InspectorProps {
  doc: IdfDocument
  model: Model
  selectedId: string | undefined
  /** The full EnergyPlus schema for the file's version, once loaded. */
  full?: FullSchema | undefined
  onFieldChange: (objectId: string, fieldIdx: number, newValue: string) => void
  onRevertObject: (objectId: string) => void
}

/** Reference list → names of the objects in the file that join it. */
function referenceNames(doc: IdfDocument, schema: Schema): Map<string, string[]> {
  const out = new Map<string, Set<string>>()
  for (const o of doc.objects.values()) {
    const type = schema.get(o.className)
    const name = o.fields[0]?.value.trim()
    if (!type?.nref || type.anon || !name) continue
    for (const list of type.nref) {
      let names = out.get(list)
      if (!names) out.set(list, (names = new Set()))
      names.add(name)
    }
  }
  return new Map([...out].map(([k, v]) => [k, [...v].sort((a, b) => a.localeCompare(b))]))
}

export function Inspector({
  doc,
  model,
  selectedId,
  full,
  onFieldChange,
  onRevertObject,
}: InspectorProps): React.JSX.Element {
  const obj = selectedId ? doc.objects.get(selectedId) : undefined
  const schema = obj ? getSchema(obj.classKey, model.version) : undefined
  const type = obj && full ? full.schema.get(obj.className) : undefined
  const refNames = useMemo(() => (full ? referenceNames(doc, full.schema) : new Map<string, string[]>()), [doc, model, full])

  // Collect available options for reference fields
  const { constructions, zones, otherSurfaces } = useMemo(() => {
    const constrList: string[] = []
    const zoneList: string[] = []
    const surfList: string[] = []

    for (const o of doc.objects.values()) {
      if (
        o.classKey.startsWith('construction') ||
        o.classKey === 'construction:internalresource'
      ) {
        const name = o.fields[0]?.value?.trim()
        if (name) constrList.push(name)
      }
      if (o.classKey === 'zone') {
        const name = o.fields[0]?.value?.trim()
        if (name) zoneList.push(name)
      }
    }

    for (const s of model.surfaces.values()) {
      if (s.id !== selectedId && s.name) {
        surfList.push(s.name)
      }
    }

    return {
      constructions: [...new Set(constrList)].sort(),
      zones: [...new Set(zoneList)].sort(),
      otherSurfaces: [...new Set(surfList)].sort(),
    }
  }, [doc, model, selectedId])

  if (!obj) {
    return (
      <div className="inspector-panel inspector-panel--empty">
        <p>No object selected.</p>
        <p className="inspector-panel__hint">
          Click any surface in the 3D viewport or select an object from the tree.
        </p>
      </div>
    )
  }

  const objName = (type?.anon ? '' : obj.fields[0]?.value) || obj.className
  const fieldCount = Math.max(
    obj.fields.length,
    schema ? schema.minFields ?? schema.fields.length : 0,
    !schema && type ? type.f.length : 0,
  )
  const memo = type?.m !== undefined ? full?.prose?.[type.m] : undefined
  const docs = type && full ? docsUrlForObject(obj.className, full.schema.version, full.schema) : undefined

  const fieldIndices = Array.from({ length: fieldCount }, (_, i) => i)

  return (
    <div className="inspector-panel">
      {/* Datalists for autocompletion */}
      <datalist id="idd-constructions">
        {constructions.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <datalist id="idd-zones">
        {zones.map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>
      <datalist id="idd-surfaces">
        {otherSurfaces.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>

      <div className="inspector-panel__header">
        <div className="inspector-panel__title-row">
          <span className="inspector-panel__class" title={memo}>
            {obj.className}
          </span>
          {docs && (
            <a className="inspector-panel__docs" href={docs.url} target="_blank" rel="noreferrer" title={docs.label}>
              Docs ↗
            </a>
          )}
          {obj.dirty && (
            <div className="inspector-panel__status">
              <span className="badge-dirty">Modified</span>
              <button
                type="button"
                className="btn-revert"
                onClick={() => onRevertObject(obj.id)}
                title="Revert this object to original text"
              >
                Revert
              </button>
            </div>
          )}
        </div>
        <div className="inspector-panel__name">{objName}</div>
      </div>

      <div className="inspector-panel__fields">
        {fieldIndices.map((i) => {
          const spec = schema ? fieldSpecAt(schema, i) : undefined
          const slot = type ? slotAt(type, i) : undefined
          const def = slot?.def
          const label = (schema ? fieldNameAt(schema, i) : undefined) ?? (slot ? displayName(slot) : `Field ${i + 1}`)
          const value = obj.fields[i]?.value ?? ''
          const units = spec?.units ?? def?.u
          const required = spec?.required ?? (slot ? type!.r?.includes(slot.key) || (i === 0 && type!.nreq === 1) : false)
          const fallback = spec?.default ?? (def?.d !== undefined ? String(def.d) : '')
          const note = def?.n !== undefined ? full?.prose?.[def.n] : undefined
          const choices = spec?.choices ?? (def?.t === 'a' ? def.e?.filter((c) => c !== '').map(String) : undefined)
          const objList = spec?.objectList ?? def?.ol
          const problem = valueProblem(def, value)
          // The select shows the canonical spelling of a value written in another case.
          const selected = choices?.find((c) => c.toLowerCase() === value.toLowerCase()) ?? value

          let datalistId: string | undefined
          if (objList?.includes('ConstructionNames')) datalistId = 'idd-constructions'
          else if (objList?.includes('ZoneNames')) datalistId = 'idd-zones'
          else if (objList?.includes('OutFaceEnvNames')) datalistId = 'idd-surfaces'
          else if (objList?.some((l) => refNames.has(l))) datalistId = `idd-refs-${i}`
          const suggestions =
            datalistId?.startsWith('idd-refs-') && objList
              ? [...new Set(objList.flatMap((l) => refNames.get(l) ?? []))]
              : undefined

          return (
            <div key={i} className="field-row">
              <div className="field-row__label-line">
                <label className="field-row__label" htmlFor={`field-${obj.id}-${i}`} title={note}>
                  {label}
                </label>
                {units && <span className="field-row__units">[{units}]</span>}
                {required && <span className="field-row__req">*</span>}
              </div>

              {choices && choices.length > 0 ? (
                <select
                  id={`field-${obj.id}-${i}`}
                  className="field-row__input field-row__select"
                  value={selected}
                  onChange={(e) => onFieldChange(obj.id, i, e.target.value)}
                >
                  {/* Allow blank if not strictly required */}
                  {!required && <option value="">{fallback ? `(Default: ${fallback})` : '(None / Default)'}</option>}
                  {selected !== '' && !choices.includes(selected) && <option value={selected}>{selected}</option>}
                  {choices.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              ) : (
                <>
                  <input
                    id={`field-${obj.id}-${i}`}
                    type="text"
                    inputMode={spec?.type === 'N' || def?.t === 'n' || def?.t === 'i' ? 'decimal' : 'text'}
                    className={`field-row__input${problem ? ' field-row__input--invalid' : ''}`}
                    list={datalistId}
                    value={value}
                    placeholder={fallback}
                    onChange={(e) => onFieldChange(obj.id, i, e.target.value)}
                  />
                  {suggestions && (
                    <datalist id={datalistId}>
                      {suggestions.map((n) => (
                        <option key={n} value={n} />
                      ))}
                    </datalist>
                  )}
                </>
              )}
              {problem && <div className="field-row__problem">{problem}</div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
