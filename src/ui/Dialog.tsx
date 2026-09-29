/**
 * An in-app dialog, in place of `window.prompt` and `window.confirm`.
 *
 * Those two are blocked outright in some embedded browsers (the call throws), unstyleable
 * everywhere, and can only ask one question at a time — which is why zone creation used to ask
 * for a name and then, separately, a height. A dialog here asks everything at once, shows the
 * consequences above the fields, and resolves a promise, so callers read as straight-line code.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export interface DialogField {
  key: string
  label: string
  value: string
  kind?: 'text' | 'number' | 'checkbox'
  /** Shown beside a checkbox, or under a text field. */
  hint?: string
}

export interface DialogSpec {
  title: string
  /** Lines of explanation above the fields; a line starting with "• " is indented. */
  message?: string[]
  fields?: DialogField[]
  confirmLabel?: string
  /** Marks the confirm button as destructive. */
  danger?: boolean
}

/** Field values by key; checkboxes read `'true'` or `'false'`. `null` when cancelled. */
export type DialogResult = Record<string, string> | null

interface Open {
  spec: DialogSpec
  resolve: (r: DialogResult) => void
}

export function useDialog(): { ask: (spec: DialogSpec) => Promise<DialogResult>; element: React.JSX.Element | null } {
  const [open, setOpen] = useState<Open | undefined>(undefined)
  const ask = useCallback(
    (spec: DialogSpec) =>
      new Promise<DialogResult>((resolve) => {
        setOpen({ spec, resolve })
      }),
    [],
  )
  const close = useCallback(
    (r: DialogResult) => {
      open?.resolve(r)
      setOpen(undefined)
    },
    [open],
  )
  return { ask, element: open ? <Dialog key={open.spec.title} spec={open.spec} onClose={close} /> : null }
}

function Dialog({ spec, onClose }: { spec: DialogSpec; onClose: (r: DialogResult) => void }): React.JSX.Element {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries((spec.fields ?? []).map((f) => [f.key, f.value])),
  )
  const first = useRef<HTMLInputElement | null>(null)
  const confirm = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (first.current) {
      first.current.focus()
      first.current.select()
    } else confirm.current?.focus()
  }, [])

  return (
    <div
      className="dialog-backdrop"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose(null)
        }
      }}
    >
      <form
        className="dialog"
        role="dialog"
        aria-label={spec.title}
        onSubmit={(e) => {
          e.preventDefault()
          onClose(values)
        }}
      >
        <h2 className="dialog__title">{spec.title}</h2>
        {spec.message?.map((line, i) => (
          <p key={i} className={line.startsWith('• ') ? 'dialog__item' : 'dialog__line'}>
            {line}
          </p>
        ))}
        {(spec.fields ?? []).map((f, i) =>
          f.kind === 'checkbox' ? (
            <label key={f.key} className="dialog__check">
              <input
                type="checkbox"
                checked={values[f.key] === 'true'}
                onChange={(e) => setValues({ ...values, [f.key]: String(e.target.checked) })}
              />
              <span>
                {f.label}
                {f.hint && <span className="dialog__hint"> — {f.hint}</span>}
              </span>
            </label>
          ) : (
            <label key={f.key} className="dialog__field">
              <span>{f.label}</span>
              <input
                ref={i === 0 ? first : undefined}
                type="text"
                inputMode={f.kind === 'number' ? 'decimal' : 'text'}
                value={values[f.key] ?? ''}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              />
              {f.hint && <span className="dialog__hint">{f.hint}</span>}
            </label>
          ),
        )}
        <div className="dialog__actions">
          <button type="button" onClick={() => onClose(null)}>
            Cancel
          </button>
          <button ref={confirm} type="submit" className={spec.danger ? 'dialog__danger' : 'button--active'}>
            {spec.confirmLabel ?? 'OK'}
          </button>
        </div>
      </form>
    </div>
  )
}
