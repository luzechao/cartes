/**
 * Object Tree component — Phase 5 of docs/05-implementation-plan.md.
 *
 * Provides hierarchical navigation of the model:
 * - Zones -> Surfaces (Walls, Roofs, Floors, Ceilings) -> SubSurfaces & Attached Shading
 * - Detached Shading surfaces
 * - Other IDF objects (Constructions, Materials, Schedules, Controls, etc.)
 */
import { useMemo, useState } from 'react'
import type { IdfDocument, IdfObject } from '../parser/types.js'
import type { Model, BuildingSurface, ShadingSurface, Zone } from '../model/index.js'

interface ObjectTreeProps {
  doc: IdfDocument
  model: Model
  selectedId: string | undefined
  onSelect: (id: string) => void
  onFocus?: (id: string) => void
}

export function ObjectTree({
  doc,
  model,
  selectedId,
  onSelect,
  onFocus,
}: ObjectTreeProps): React.JSX.Element {
  const [filter, setFilter] = useState('')
  const [expandedZones, setExpandedZones] = useState<Record<string, boolean>>({})
  const [expandedSurfaces, setExpandedSurfaces] = useState<Record<string, boolean>>({})
  const [showOther, setShowOther] = useState(false)

  const toggleZone = (zid: string) => {
    setExpandedZones((prev) => ({ ...prev, [zid]: !prev[zid] }))
  }

  const toggleSurface = (sid: string) => {
    setExpandedSurfaces((prev) => ({ ...prev, [sid]: !prev[sid] }))
  }

  // Group surfaces by zone
  const { zoneSurfaces, shadingSurfaces, otherObjects } = useMemo(() => {
    const zMap = new Map<string, BuildingSurface[]>()
    for (const zid of model.zones.keys()) {
      zMap.set(zid, [])
    }

    const shading: ShadingSurface[] = []

    for (const surface of model.surfaces.values()) {
      if (surface.kind === 'shading') {
        shading.push(surface)
        continue
      }
      if (surface.kind === 'base') {
        const zid = model.zoneOf.get(surface.id)
        if (zid && zMap.has(zid)) {
          zMap.get(zid)!.push(surface)
        }
      }
    }

    // Collect non-surface objects
    const others: IdfObject[] = []
    for (const obj of doc.objects.values()) {
      if (!model.surfaces.has(obj.id) && !model.zones.has(obj.id)) {
        others.push(obj)
      }
    }

    return {
      zoneSurfaces: zMap,
      shadingSurfaces: shading,
      otherObjects: others,
    }
  }, [doc, model])

  const q = filter.trim().toLowerCase()

  return (
    <aside className="tree-panel">
      <div className="tree-panel__search">
        <input
          type="text"
          placeholder="Filter objects..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {filter && (
          <button
            type="button"
            className="tree-panel__clear"
            onClick={() => setFilter('')}
          >
            ✕
          </button>
        )}
      </div>

      <div className="tree-panel__list">
        {/* Zones and their surfaces */}
        <div className="tree-group">
          <div className="tree-group__title">Thermal Zones ({model.zones.size})</div>
          {Array.from(model.zones.values()).map((zone: Zone) => {
            const surfaces = zoneSurfaces.get(zone.id) ?? []
            const isExpanded = expandedZones[zone.id] ?? (filter.length > 0 || model.zones.size <= 5)
            const zoneMatches = !q || zone.name.toLowerCase().includes(q)
            const matchingSurfaces = q
              ? surfaces.filter(
                  (s) =>
                    s.name.toLowerCase().includes(q) ||
                    s.surfaceType.toLowerCase().includes(q) ||
                    s.constructionName.toLowerCase().includes(q) ||
                    s.subSurfaces.some((subId) => {
                      const sub = model.surfaces.get(subId)
                      return sub && sub.name.toLowerCase().includes(q)
                    }),
                )
              : surfaces

            if (!zoneMatches && matchingSurfaces.length === 0) return null

            const isZoneSelected = selectedId === zone.id
            const isZoneDirty = doc.objects.get(zone.id)?.dirty

            return (
              <div key={zone.id} className="tree-node">
                <div
                  className={`tree-node__header${isZoneSelected ? ' tree-node__header--selected' : ''}`}
                  onClick={() => onSelect(zone.id)}
                >
                  <button
                    type="button"
                    className="tree-node__toggle"
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleZone(zone.id)
                    }}
                  >
                    {isExpanded ? '▼' : '▶'}
                  </button>
                  <span className="tree-node__icon">🏢</span>
                  <span className="tree-node__name" title={zone.name}>
                    {zone.name}
                  </span>
                  {isZoneDirty && <span className="badge-dirty">M</span>}
                  <span className="tree-node__count">({surfaces.length})</span>
                </div>

                {isExpanded && (
                  <div className="tree-node__children">
                    {matchingSurfaces.map((s) => {
                      const isSurfaceSelected = selectedId === s.id
                      const isSurfaceDirty = doc.objects.get(s.id)?.dirty
                      const hasSub =
                        s.subSurfaces.length > 0 || s.attachedShading.length > 0
                      const isSubExpanded = expandedSurfaces[s.id] ?? (filter.length > 0)

                      return (
                        <div key={s.id} className="tree-node">
                          <div
                            className={`tree-node__item${isSurfaceSelected ? ' tree-node__item--selected' : ''}`}
                            onClick={() => onSelect(s.id)}
                          >
                            {hasSub ? (
                              <button
                                type="button"
                                className="tree-node__toggle"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  toggleSurface(s.id)
                                }}
                              >
                                {isSubExpanded ? '▼' : '▶'}
                              </button>
                            ) : (
                              <span className="tree-node__spacer" />
                            )}
                            <span className={`type-dot type-dot--${s.surfaceType.toLowerCase()}`} />
                            <span className="tree-node__name" title={s.name}>
                              {s.name}
                            </span>
                            {isSurfaceDirty && <span className="badge-dirty">M</span>}
                            {onFocus && (
                              <button
                                type="button"
                                className="tree-node__focus-btn"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  onSelect(s.id)
                                  onFocus(s.id)
                                }}
                                title="Frame in 3D"
                              >
                                🎯
                              </button>
                            )}
                          </div>

                          {hasSub && isSubExpanded && (
                            <div className="tree-node__subchildren">
                              {s.subSurfaces.map((subId) => {
                                const sub = model.surfaces.get(subId)
                                if (!sub) return null
                                const isSubSelected = selectedId === sub.id
                                const isSubDirty = doc.objects.get(sub.id)?.dirty
                                return (
                                  <div
                                    key={sub.id}
                                    className={`tree-node__subitem${isSubSelected ? ' tree-node__subitem--selected' : ''}`}
                                    onClick={() => onSelect(sub.id)}
                                  >
                                    <span className="type-dot type-dot--window" />
                                    <span className="tree-node__name" title={sub.name}>
                                      {sub.name}
                                    </span>
                                    {isSubDirty && <span className="badge-dirty">M</span>}
                                    {onFocus && (
                                      <button
                                        type="button"
                                        className="tree-node__focus-btn"
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          onSelect(sub.id)
                                          onFocus(sub.id)
                                        }}
                                        title="Frame in 3D"
                                      >
                                        🎯
                                      </button>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Detached shading */}
        {shadingSurfaces.length > 0 && (
          <div className="tree-group">
            <div className="tree-group__title">Shading ({shadingSurfaces.length})</div>
            {shadingSurfaces.map((s) => {
              if (q && !s.name.toLowerCase().includes(q)) return null
              const isSelected = selectedId === s.id
              const isDirty = doc.objects.get(s.id)?.dirty
              return (
                <div
                  key={s.id}
                  className={`tree-node__item${isSelected ? ' tree-node__item--selected' : ''}`}
                  onClick={() => onSelect(s.id)}
                >
                  <span className="type-dot type-dot--shading" />
                  <span className="tree-node__name" title={s.name}>
                    {s.name}
                  </span>
                  {isDirty && <span className="badge-dirty">M</span>}
                  {onFocus && (
                    <button
                      type="button"
                      className="tree-node__focus-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        onSelect(s.id)
                        onFocus(s.id)
                      }}
                      title="Frame in 3D"
                    >
                      🎯
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* Other Objects (Non-surface IDF objects) */}
        {otherObjects.length > 0 && (
          <div className="tree-group">
            <div
              className="tree-group__title tree-group__title--clickable"
              onClick={() => setShowOther(!showOther)}
            >
              <span>{showOther ? '▼' : '▶'} Other Objects ({otherObjects.length})</span>
            </div>
            {showOther && (
              <div className="tree-group__content">
                {otherObjects.map((obj) => {
                  const name = obj.fields[0]?.value || obj.className
                  if (
                    q &&
                    !name.toLowerCase().includes(q) &&
                    !obj.className.toLowerCase().includes(q)
                  ) {
                    return null
                  }
                  const isSelected = selectedId === obj.id
                  return (
                    <div
                      key={obj.id}
                      className={`tree-node__item${isSelected ? ' tree-node__item--selected' : ''}`}
                      onClick={() => onSelect(obj.id)}
                    >
                      <span className="tree-node__class">{obj.className}</span>
                      <span className="tree-node__name" title={name}>
                        {name}
                      </span>
                      {obj.dirty && <span className="badge-dirty">M</span>}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}

