/**
 * Ribbon toolbar: tabs of grouped, icon-labelled commands.
 * - Geometry: file and examples, history, panels, edit modes and snapping, create/modify, view.
 * - Simulate: weather, PythonPlugin modules and Pyodide packages; run; open results.
 */
import { useEffect, useRef, useState } from 'react'
import type { SnapSettings } from '../geometry/index.js'
import type { ColorBy } from '../render/index.js'
import type { Example } from './examples.js'
import type { Simulation } from './useSimulation.js'
import {
  ChangesIcon,
  ChevronDownIcon,
  CloseIcon,
  ConsoleIcon,
  CornerIcon,
  DeleteIcon,
  DoorIcon,
  DrawZoneIcon,
  ExamplesIcon,
  FitIcon,
  ImageIcon,
  InspectorIcon,
  LinkIcon,
  LogoIcon,
  MagnetIcon,
  MatchingIcon,
  MoveIcon,
  NewIcon,
  OpenIcon,
  PackageIcon,
  PaletteIcon,
  PluginIcon,
  RedoIcon,
  ReportIcon,
  RunIcon,
  SelectIcon,
  SpinnerIcon,
  StoriesIcon,
  TreeIcon,
  UndoIcon,
  ValidationIcon,
  VertexIcon,
  WeatherIcon,
  WindowIcon,
} from './icons.js'

type RibbonTab = 'geometry' | 'simulate'

export type EditMode = 'off' | 'vertex' | 'corner' | 'draw'

export interface GeometryCommands {
  onNew: () => void
  onOpenFile: (file: File) => void
  examples: readonly Example[]
  onLoadExample: (example: Example) => void
  changesCount: number
  onShowChanges: () => void

  canUndo: boolean
  undoLabel: string | undefined
  onUndo: () => void
  canRedo: boolean
  redoLabel: string | undefined
  onRedo: () => void

  treeVisible: boolean
  onToggleTree: () => void
  inspectorVisible: boolean
  onToggleInspector: () => void
  validationVisible: boolean
  validationCount: number
  onToggleValidation: () => void
  matchingVisible: boolean
  matchingCount: number
  onToggleMatching: () => void

  editMode: EditMode
  /** Editing needs stories stacked in place; with them exploded or isolated, only Select is available. */
  editLocked: boolean
  onEditMode: (mode: EditMode) => void
  snap: SnapSettings
  onSnap: (snap: SnapSettings) => void

  /** A base surface is selected, so an opening can go on it. */
  canAddOpening: boolean
  onAddWindow: () => void
  onAddDoor: () => void
  /** In vertex or corner mode with a surface selected. */
  canModifySelection: boolean
  onMoveZone: () => void
  onDelete: () => void

  colorBy: ColorBy
  onColorByChange: (colorBy: ColorBy) => void
  /** Present when the model has more than one story. */
  stories: { value: string; options: Array<{ value: string; label: string }> } | undefined
  onStories: (value: string) => void
  onFit: () => void
  onShareLink: () => void
  onSaveImage: () => void
}

interface RibbonProps {
  /** One-line description of the open model, shown at the right of the tab row. */
  meta: string | undefined
  hasModel: boolean
  geometry: GeometryCommands

  simulation: Simulation
  /** Whether the model has unsaved edits (the run includes them). */
  edited: boolean
  onRun: () => void
  consoleVisible: boolean
  onToggleConsole: () => void
}

export function Ribbon(props: RibbonProps): React.JSX.Element {
  const [tab, setTab] = useState<RibbonTab>('geometry')
  const { simulation } = props

  const selectTab = (next: RibbonTab): void => {
    setTab(next)
    // Fetch the ~45 MB engine as soon as the user shows interest, so Simulate is ready when clicked.
    if (next === 'simulate' && props.hasModel) simulation.loadEngine()
  }

  return (
    <header className="ribbon">
      <div className="ribbon__tabs" role="tablist">
        <span className="ribbon__brand">
          <LogoIcon size={18} />
          cartes
        </span>
        <span className="ribbon__quick" role="group" aria-label="Quick access">
          <button
            type="button"
            className="ribbon__quick-button"
            onClick={props.geometry.onUndo}
            disabled={!props.hasModel || !props.geometry.canUndo}
            title={props.geometry.undoLabel ? `Undo ${props.geometry.undoLabel} (Ctrl+Z)` : 'Nothing to undo'}
            aria-label="Undo"
          >
            <UndoIcon size={16} />
          </button>
          <button
            type="button"
            className="ribbon__quick-button"
            onClick={props.geometry.onRedo}
            disabled={!props.hasModel || !props.geometry.canRedo}
            title={props.geometry.redoLabel ? `Redo ${props.geometry.redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo'}
            aria-label="Redo"
          >
            <RedoIcon size={16} />
          </button>
        </span>
        <RibbonTabButton id="geometry" label="Geometry" active={tab} onSelect={selectTab} />
        <RibbonTabButton
          id="simulate"
          label="Simulate"
          active={tab}
          onSelect={selectTab}
          badge={simulation.running ? 'running' : undefined}
        />
        <span className="spacer" />
        {props.meta && <span className="ribbon__meta">{props.meta}</span>}
      </div>

      <div className="ribbon__body" role="tabpanel">
        {tab === 'geometry' ? <GeometryTab hasModel={props.hasModel} {...props.geometry} /> : <SimulateTab {...props} />}
      </div>
    </header>
  )
}

function RibbonTabButton({
  id,
  label,
  active,
  onSelect,
  badge,
}: {
  id: RibbonTab
  label: string
  active: RibbonTab
  onSelect: (tab: RibbonTab) => void
  badge?: string | undefined
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active === id}
      className={`ribbon__tab${active === id ? ' ribbon__tab--active' : ''}`}
      onClick={() => onSelect(id)}
    >
      {label}
      {badge && <span className="ribbon__tab-badge">{badge}</span>}
    </button>
  )
}

const EDIT_MODES: Array<{ mode: EditMode; label: string; icon: React.ReactNode; title: string }> = [
  { mode: 'off', label: 'Select', icon: <SelectIcon />, title: 'Select and inspect only' },
  { mode: 'vertex', label: 'Vertex', icon: <VertexIcon />, title: 'Drag vertices within their surface plane' },
  { mode: 'corner', label: 'Corner', icon: <CornerIcon />, title: 'Drag building corners in plan' },
  { mode: 'draw', label: 'Draw zone', icon: <DrawZoneIcon />, title: 'Draw a zone footprint and extrude it' },
]

const GRID_SIZES = [0.01, 0.05, 0.1, 0.25, 0.5, 1]

function GeometryTab(props: GeometryCommands & { hasModel: boolean }): React.JSX.Element {
  const off = !props.hasModel
  const snapOff = off || props.editMode === 'off'
  return (
    <>
      <RibbonGroup label="File">
        <RibbonButton icon={<NewIcon />} label="New" onClick={props.onNew} title="Start a new model from the authoring template" />
        <FileButton
          icon={<OpenIcon />}
          label="Open IDF"
          accept=".idf,.imf,text/plain"
          onFiles={([f]) => f && props.onOpenFile(f)}
          title="Open an EnergyPlus IDF file (or drop one on the canvas)"
        />
        <ExamplesMenu examples={props.examples} onLoad={props.onLoadExample} />
        <RibbonButton
          icon={<ChangesIcon />}
          label="Changes"
          badge={props.changesCount}
          onClick={props.onShowChanges}
          disabled={off}
          highlighted={props.changesCount > 0}
          title="Live diff, raw IDF and download"
        />
      </RibbonGroup>

      <RibbonGroup label="Panels">
        <RibbonButton icon={<TreeIcon />} label="Tree" onClick={props.onToggleTree} disabled={off} active={props.treeVisible} title="Object tree" />
        <RibbonButton icon={<InspectorIcon />} label="Inspector" onClick={props.onToggleInspector} disabled={off} active={props.inspectorVisible} title="Property inspector" />
        <RibbonButton
          icon={<ValidationIcon />}
          label="Validation"
          badge={props.validationCount}
          onClick={props.onToggleValidation}
          disabled={off}
          active={props.validationVisible}
          title="Geometry validation issues"
        />
        <RibbonButton
          icon={<MatchingIcon />}
          label="Matching"
          badge={props.matchingCount}
          onClick={props.onToggleMatching}
          disabled={off}
          active={props.matchingVisible}
          title="Review proposed interzone surface pairs"
        />
      </RibbonGroup>

      <RibbonGroup label="Edit">
        {EDIT_MODES.map(({ mode, label, icon, title }) => (
          <RibbonButton
            key={mode}
            icon={icon}
            label={label}
            onClick={() => props.onEditMode(mode)}
            disabled={off || (mode !== 'off' && props.editLocked)}
            active={props.hasModel && props.editMode === mode}
            title={mode !== 'off' && props.editLocked ? `${title} (stack the stories first)` : title}
          />
        ))}
        <div className={`ribbon__snap${snapOff ? ' ribbon__snap--off' : ''}`} title="Snapping while editing">
          <span className="ribbon__snap-title">
            <MagnetIcon size={14} /> Snap
          </span>
          {(['vertex', 'edge', 'grid'] as const).map((kind) => (
            <label key={kind} className="ribbon__check">
              <input
                type="checkbox"
                disabled={snapOff}
                checked={props.snap[kind]}
                onChange={(e) => props.onSnap({ ...props.snap, [kind]: e.target.checked })}
              />
              {kind}
              {kind === 'grid' && (
                <select
                  disabled={snapOff || !props.snap.grid}
                  value={props.snap.gridSize}
                  onChange={(e) => props.onSnap({ ...props.snap, gridSize: Number(e.target.value) })}
                  title="Grid spacing"
                >
                  {GRID_SIZES.map((g) => (
                    <option key={g} value={g}>
                      {g} m
                    </option>
                  ))}
                </select>
              )}
            </label>
          ))}
        </div>
      </RibbonGroup>

      <RibbonGroup label="Create & modify">
        <div className="ribbon__stack">
          <SmallButton
            icon={<WindowIcon />}
            label="Window"
            onClick={props.onAddWindow}
            disabled={off || !props.canAddOpening}
            title={props.canAddOpening ? 'Add a window to the selected surface' : 'Select a wall, roof or floor to add a window'}
          />
          <SmallButton
            icon={<DoorIcon />}
            label="Door"
            onClick={props.onAddDoor}
            disabled={off || !props.canAddOpening}
            title={props.canAddOpening ? 'Add a door to the selected surface' : 'Select a wall to add a door'}
          />
        </div>
        <div className="ribbon__stack">
          <SmallButton
            icon={<MoveIcon />}
            label="Move zone…"
            onClick={props.onMoveZone}
            disabled={off || !props.canModifySelection}
            title={props.canModifySelection ? "Translate the selected surface's zone" : 'In Vertex or Corner mode, select a surface first'}
          />
          <SmallButton
            icon={<DeleteIcon />}
            label="Delete"
            onClick={props.onDelete}
            disabled={off || !props.canModifySelection}
            title={props.canModifySelection ? 'Delete the active vertex, or the surface' : 'In Vertex or Corner mode, select a surface first'}
          />
        </div>
      </RibbonGroup>

      <RibbonGroup label="View">
        <div className="ribbon__stack ribbon__stack--controls">
          <label className="ribbon__select" title="Color surfaces by">
            <PaletteIcon size={16} />
            <select value={props.colorBy} onChange={(e) => props.onColorByChange(e.target.value as ColorBy)}>
              <option value="type">Color by type</option>
              <option value="construction">Color by construction</option>
            </select>
          </label>
          <label className="ribbon__select" title={props.stories ? 'Pull stories apart, or show one at a time' : 'Single-story model'}>
            <StoriesIcon size={16} />
            <select
              disabled={!props.stories}
              value={props.stories?.value ?? 'stacked'}
              onChange={(e) => props.onStories(e.target.value)}
            >
              {(props.stories?.options ?? [{ value: 'stacked', label: 'Stories stacked' }]).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <RibbonButton icon={<FitIcon />} label="Fit" onClick={props.onFit} disabled={off} title="Fit the model in view" />
        <div className="ribbon__stack">
          <SmallButton icon={<LinkIcon />} label="Link" onClick={props.onShareLink} disabled={off} title="Copy a link to this view" />
          <SmallButton icon={<ImageIcon />} label="Image" onClick={props.onSaveImage} disabled={off} title="Save the view as a PNG image" />
        </div>
      </RibbonGroup>
    </>
  )
}

function ExamplesMenu({ examples, onLoad }: { examples: readonly Example[]; onLoad: (example: Example) => void }): React.JSX.Element {
  // Fixed-position menu: the ribbon body scrolls horizontally, which would clip an absolutely positioned one.
  const [anchor, setAnchor] = useState<{ top: number; left: number } | undefined>(undefined)
  const root = useRef<HTMLDivElement | null>(null)
  const open = anchor !== undefined

  useEffect(() => {
    if (!open) return
    const close = (): void => setAnchor(undefined)
    const onDown = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) close()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
    }
  }, [open])

  return (
    <div className="ribbon__menu-root" ref={root}>
      <button
        type="button"
        className={`ribbon__button${open ? ' ribbon__button--active' : ''}`}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          setAnchor(open ? undefined : { top: rect.bottom + 4, left: rect.left })
        }}
        title="Open an EnergyPlus 26.1 example model"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="ribbon__icon">
          <ExamplesIcon />
        </span>
        <span className="ribbon__label">
          Examples <ChevronDownIcon size={10} />
        </span>
      </button>
      {anchor && (
        <div className="ribbon__menu" role="menu" style={{ top: anchor.top, left: anchor.left }}>
          <div className="ribbon__menu-heading">EnergyPlus 26.1 examples</div>
          {examples.map((example) => (
            <button
              key={example.id}
              type="button"
              role="menuitem"
              className="ribbon__menu-item"
              onClick={() => {
                setAnchor(undefined)
                onLoad(example)
              }}
            >
              <span className="ribbon__menu-title">
                {example.title}
                {example.plugins.length > 0 && <span className="ribbon__menu-tag">PythonPlugin</span>}
              </span>
              <span className="ribbon__menu-desc">{example.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function SimulateTab(props: RibbonProps): React.JSX.Element {
  const { simulation } = props
  const off = !props.hasModel
  const report = simulation.outputs.find((file) => file.name === 'eplustbl.htm')
  const engineNote =
    simulation.engine.state === 'loading'
      ? 'Loading engine…'
      : simulation.engine.state === 'error'
        ? 'Engine failed to load'
        : simulation.engine.state === 'ready'
          ? `EnergyPlus ${simulation.engine.info.energyPlusVersion}`
          : 'EnergyPlus 26.1 in your browser'

  return (
    <>
      <RibbonGroup label="Inputs">
        <div className="ribbon__input">
          <FileButton
            icon={<WeatherIcon />}
            label="Weather"
            accept=".epw"
            onFiles={([f]) => simulation.setEpw(f)}
            active={simulation.epw !== undefined}
            title="Load an EPW weather file. Without one, only the model's design days are simulated."
          />
          <InputCaption
            text={simulation.epw?.name ?? 'Design days only'}
            onClear={simulation.epw ? () => simulation.setEpw(undefined) : undefined}
          />
        </div>
        <div className="ribbon__input">
          <FileButton
            icon={<PluginIcon />}
            label="Plugins (.py)"
            accept=".py"
            multiple
            onFiles={(files) => simulation.setPluginFiles(files)}
            active={simulation.pluginFiles.length > 0}
            title="Load the Python modules named by the model's PythonPlugin:Instance objects"
          />
          <InputCaption
            text={
              simulation.pluginFiles.length === 0
                ? 'None'
                : simulation.pluginFiles.length === 1
                  ? simulation.pluginFiles[0]!.name
                  : `${simulation.pluginFiles.length} modules`
            }
            title={simulation.pluginFiles.map((f) => f.name).join('\n')}
            onClear={simulation.pluginFiles.length ? () => simulation.setPluginFiles([]) : undefined}
          />
        </div>
        <label className="ribbon__field" title="Pyodide packages the plugins import, comma separated">
          <span className="ribbon__field-label">
            <PackageIcon size={16} /> Packages
          </span>
          <input type="text" placeholder="e.g. numpy" value={simulation.packages} onChange={(e) => simulation.setPackages(e.target.value)} />
        </label>
      </RibbonGroup>

      <RibbonGroup label="Run">
        <RibbonButton
          icon={simulation.running ? <SpinnerIcon size={28} /> : <RunIcon size={28} />}
          label={simulation.running ? 'Simulating…' : props.edited ? 'Simulate edited' : 'Simulate'}
          onClick={props.onRun}
          disabled={off || simulation.running || simulation.engine.state === 'error'}
          primary
          title={off ? 'Open an IDF first' : 'Run EnergyPlus on the current model, including unsaved edits'}
        />
        <span className="ribbon__note">{engineNote}</span>
      </RibbonGroup>

      <RibbonGroup label="Results">
        <RibbonButton
          icon={<ReportIcon />}
          label="Report"
          onClick={() => report && window.open(report.url, '_blank', 'noopener')}
          disabled={!report}
          title="Open the EnergyPlus tabular report (eplustbl.htm)"
        />
        <RibbonButton
          icon={<ConsoleIcon />}
          label="Console"
          onClick={props.onToggleConsole}
          disabled={off}
          active={props.consoleVisible}
          title="Console output, messages and output files in the sidebar"
        />
      </RibbonGroup>
    </>
  )
}

function RibbonGroup({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="ribbon__group" aria-label={label}>
      <div className="ribbon__group-items">{children}</div>
      <div className="ribbon__group-label">{label}</div>
    </section>
  )
}

interface RibbonButtonProps {
  icon: React.ReactNode
  label: string
  onClick: () => void
  title: string
  disabled?: boolean | undefined
  active?: boolean | undefined
  highlighted?: boolean | undefined
  primary?: boolean | undefined
  /** Count shown on the icon's corner; hidden when zero. */
  badge?: number | undefined
}

function RibbonButton({ icon, label, onClick, title, disabled, active, highlighted, primary, badge }: RibbonButtonProps): React.JSX.Element {
  const classes = ['ribbon__button']
  if (active) classes.push('ribbon__button--active')
  if (highlighted) classes.push('ribbon__button--highlighted')
  if (primary) classes.push('ribbon__button--primary')
  return (
    <button
      type="button"
      className={classes.join(' ')}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active}
      aria-label={badge ? `${label} (${badge})` : undefined}
    >
      <span className="ribbon__icon">
        {icon}
        {badge ? (
          <span className="ribbon__badge" aria-hidden="true">
            {badge > 99 ? '99+' : badge}
          </span>
        ) : null}
      </span>
      <span className="ribbon__label">{label}</span>
    </button>
  )
}

/** Compact command: 16 px icon beside its label, stacked in a column of two or three. */
function SmallButton({ icon, label, onClick, title, disabled }: Omit<RibbonButtonProps, 'highlighted' | 'primary' | 'active' | 'badge'>): React.JSX.Element {
  return (
    <button type="button" className="ribbon__small" onClick={onClick} disabled={disabled} title={title}>
      <span className="ribbon__small-icon">{icon}</span>
      {label}
    </button>
  )
}

function FileButton({
  icon,
  label,
  accept,
  multiple,
  onFiles,
  title,
  active,
}: {
  icon: React.ReactNode
  label: string
  accept: string
  multiple?: boolean
  onFiles: (files: File[]) => void
  title: string
  active?: boolean
}): React.JSX.Element {
  const input = useRef<HTMLInputElement | null>(null)
  return (
    <>
      <RibbonButton icon={icon} label={label} onClick={() => input.current?.click()} title={title} active={active} />
      <input
        ref={input}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        onChange={(e) => {
          onFiles([...(e.target.files ?? [])])
          // Allow choosing the same file again after clearing it.
          e.target.value = ''
        }}
      />
    </>
  )
}

function InputCaption({ text, title, onClear }: { text: string; title?: string; onClear?: (() => void) | undefined }): React.JSX.Element {
  return (
    <span className="ribbon__caption" title={title ?? text}>
      <span className="ribbon__caption-text">{text}</span>
      {onClear && (
        <button type="button" className="ribbon__clear" onClick={onClear} title="Clear">
          <CloseIcon size={12} />
        </button>
      )}
    </span>
  )
}
