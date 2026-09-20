/**
 * Declarative Property Inspector — Phase 5 of docs/05-implementation-plan.md.
 *
 * Driven by the IDD field table from src/model/idd.ts, providing schema-driven editing
 * for every EnergyPlus class (surfaces, constructions, schedules, materials, etc.).
 */
import { useMemo } from 'react'
import type { IdfDocument } from '../parser/types.js'
import type { Model } from '../model/index.js'
import { getSchema, fieldNameAt, fieldSpecAt } from '../model/idd.js'

interface InspectorProps {
  doc: IdfDocument
  model: Model
  selectedId: string | undefined
  onFieldChange: (objectId: string, fieldIdx: number, newValue: string) => void
  onRevertObject: (objectId: string) => void
}

export function Inspector({
  doc,
  model,
  selectedId,
  onFieldChange,
  onRevertObject,
}: InspectorProps): React.JSX.Element {
  const obj = selectedId ? doc.objects.get(selectedId) : undefined
  const schema = obj ? getSchema(obj.classKey, model.version) : undefined

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

  const objName = obj.fields[0]?.value || obj.className
  const fieldCount = Math.max(
    obj.fields.length,
    schema ? schema.minFields ?? schema.fields.length : 0,
  )

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
          <span className="inspector-panel__class">{obj.className}</span>
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
          const label = schema
            ? fieldNameAt(schema, i) ?? `Field ${i + 1}`
            : `Field ${i + 1}`
          const value = obj.fields[i]?.value ?? ''
          const choices = spec?.choices
          const objList = spec?.objectList

          let datalistId: string | undefined
          if (objList?.includes('ConstructionNames')) datalistId = 'idd-constructions'
          else if (objList?.includes('ZoneNames')) datalistId = 'idd-zones'
          else if (objList?.includes('OutFaceEnvNames')) datalistId = 'idd-surfaces'

          return (
            <div key={i} className="field-row">
              <div className="field-row__label-line">
                <label className="field-row__label" htmlFor={`field-${obj.id}-${i}`}>
                  {label}
                </label>
                {spec?.units && (
                  <span className="field-row__units">[{spec.units}]</span>
                )}
                {spec?.required && <span className="field-row__req">*</span>}
              </div>

              {choices && choices.length > 0 ? (
                <select
                  id={`field-${obj.id}-${i}`}
                  className="field-row__input field-row__select"
                  value={value}
                  onChange={(e) => onFieldChange(obj.id, i, e.target.value)}
                >
                  {/* Allow blank if not strictly required */}
                  {!spec?.required && <option value="">(None / Default)</option>}
                  {choices.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={`field-${obj.id}-${i}`}
                  type={spec?.type === 'N' ? 'text' : 'text'}
                  inputMode={spec?.type === 'N' ? 'decimal' : 'text'}
                  className="field-row__input"
                  list={datalistId}
                  value={value}
                  placeholder={spec?.default ?? ''}
                  onChange={(e) => onFieldChange(obj.id, i, e.target.value)}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
