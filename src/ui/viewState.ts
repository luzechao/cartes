/**
 * Shareable view state — Phase 9 of docs/05-implementation-plan.md.
 *
 * The camera, the selection, the colour mode and the storey display, as a URL fragment rather
 * than EPShape's copy-this-string. A fragment never leaves the browser (it is not sent to any
 * server), so the link carries a view, not the model: whoever opens it opens the same file and
 * sees what the sender saw.
 *
 * Decoding is total: anything malformed is dropped field by field, never thrown, because a link
 * is user input that has been through chat clients and email.
 */

export type ColorMode = 'type' | 'construction'
export type DisplayState = { mode: 'stacked' } | { mode: 'exploded' } | { mode: 'solo'; storey: number }

export interface ViewState {
  camera?: { position: [number, number, number]; target: [number, number, number] }
  /** Selected object, by name — ids are positional and change between files, names do not. */
  selected?: string
  colorBy?: ColorMode
  display?: DisplayState
}

const VERSION = '1'

function num(n: number): string {
  // Millimetres are plenty for a camera, and keep links short.
  return String(Math.round(n * 1000) / 1000)
}

export function encodeViewState(state: ViewState): string {
  const p = new URLSearchParams()
  p.set('v', VERSION)
  if (state.camera) p.set('cam', [...state.camera.position, ...state.camera.target].map(num).join(','))
  if (state.selected) p.set('sel', state.selected)
  if (state.colorBy && state.colorBy !== 'type') p.set('color', state.colorBy)
  if (state.display && state.display.mode !== 'stacked') {
    p.set('display', state.display.mode === 'solo' ? `solo:${state.display.storey}` : state.display.mode)
  }
  return p.toString()
}

export function decodeViewState(fragment: string): ViewState {
  const p = new URLSearchParams(fragment.replace(/^#/, ''))
  const out: ViewState = {}
  if (p.get('v') !== VERSION) return out

  const cam = p.get('cam')?.split(',').map(Number)
  if (cam && cam.length === 6 && cam.every(Number.isFinite)) {
    out.camera = { position: [cam[0]!, cam[1]!, cam[2]!], target: [cam[3]!, cam[4]!, cam[5]!] }
  }
  const sel = p.get('sel')
  if (sel) out.selected = sel
  const color = p.get('color')
  if (color === 'construction' || color === 'type') out.colorBy = color
  const display = p.get('display')
  if (display === 'exploded') out.display = { mode: 'exploded' }
  else if (display?.startsWith('solo:')) {
    const storey = Number(display.slice(5))
    if (Number.isInteger(storey) && storey >= 0) out.display = { mode: 'solo', storey }
  }
  return out
}
