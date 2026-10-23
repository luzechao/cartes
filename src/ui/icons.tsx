/**
 * Ribbon icons: 24×24, stroke-only, drawn with `currentColor` so they follow the button's text color.
 */
import type { SVGProps } from 'react'

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number }

function Svg({ size = 24, ...props }: IconProps & { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    />
  )
}

/** Isometric box with a highlighted face: the app mark. */
export function LogoIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M12 2.5 3.5 7.2v9.6L12 21.5l8.5-4.7V7.2z" />
      <path d="M3.5 7.2 12 12l8.5-4.8M12 12v9.5" />
      <path d="M12 12 20.5 7.2v9.6L12 21.5z" fill="currentColor" fillOpacity={0.25} stroke="none" />
    </Svg>
  )
}

export function OpenIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M3 7.5A2 2 0 0 1 5 5.5h4l2 2h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M12 16.5v-6M9.5 13 12 10.5l2.5 2.5" />
    </Svg>
  )
}

export function ChangesIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <rect x="3.5" y="3" width="11" height="14" rx="1.5" />
      <path d="M8.5 21H18a1.5 1.5 0 0 0 1.5-1.5V8" />
      <path d="M6.5 7.5h5M9 5v5M6.5 13.5h5" />
    </Svg>
  )
}

export function TreeIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <rect x="3" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="10" width="7" height="4" rx="1" />
      <rect x="14" y="17" width="7" height="4" rx="1" />
      <path d="M6.5 8v11H14M6.5 12H14" />
    </Svg>
  )
}

export function InspectorIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
      <circle cx="15" cy="6" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="18" r="2" />
    </Svg>
  )
}

export function ValidationIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M12 3 5 6v5.2c0 4.4 2.9 8.3 7 9.8 4.1-1.5 7-5.4 7-9.8V6z" />
      <path d="m9 12 2.2 2.2L15.5 10" />
    </Svg>
  )
}

export function PaletteIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M12 3a9 9 0 1 0 0 18c1.2 0 1.7-1 1.2-1.9-.6-1.1 0-2.4 1.3-2.4H17a4 4 0 0 0 4-4C21 7.2 17 3 12 3z" />
      <circle cx="7.5" cy="11.5" r="1.1" fill="currentColor" />
      <circle cx="10" cy="7.3" r="1.1" fill="currentColor" />
      <circle cx="15" cy="7.8" r="1.1" fill="currentColor" />
    </Svg>
  )
}

export function FitIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
      <path d="M12 8.5 8.5 10.4v3.2L12 15.5l3.5-1.9v-3.2z" />
      <path d="M8.5 10.4 12 12.3l3.5-1.9M12 12.3v3.2" />
    </Svg>
  )
}

export function WeatherIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8.5" r="3" />
      <path d="M8 2.5V4M2 8.5h1.5M3.8 4.3l1 1M12.2 4.3l-1 1" />
      <path d="M8.5 20.5h9.5a3.5 3.5 0 0 0 .3-7 5 5 0 0 0-9.4-1.4 4.2 4.2 0 0 0-.4 8.4z" />
    </Svg>
  )
}

export function PluginIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="m10 12.5-2 2 2 2M14 12.5l2 2-2 2" />
    </Svg>
  )
}

export function PackageIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M12 3 4 7v10l8 4 8-4V7z" />
      <path d="m4 7 8 4 8-4M12 11v10M8 5l8 4" />
    </Svg>
  )
}

export function RunIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8.3v7.4l6-3.7z" fill="currentColor" />
    </Svg>
  )
}

/** Shown on the Simulate button while a run is in flight. */
export function SpinnerIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" strokeOpacity={0.25} />
      <path d="M21 12a9 9 0 0 0-9-9">
        <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" />
      </path>
    </Svg>
  )
}

export function ReportIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M15 3v4h4" />
      <path d="M9.5 17.5v-3M12.5 17.5v-6M15.5 17.5v-4" />
    </Svg>
  )
}

export function ConsoleIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9.5 3 2.5-3 2.5M12.5 15H17" />
    </Svg>
  )
}

export function CloseIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M7 7l10 10M17 7 7 17" />
    </Svg>
  )
}

export function NewIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M12 11.5v6M9 14.5h6" />
    </Svg>
  )
}

export function ExamplesIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v15H5.5A1.5 1.5 0 0 0 4 20.5z" />
      <path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v15h5.5a1.5 1.5 0 0 1 1.5 1.5z" />
      <path d="M11 19c0 .8.9 1.5 2 1.5M6.5 8h2M15.5 8h2M6.5 11h2" />
    </Svg>
  )
}

export function ChevronDownIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="m6 9 6 6 6-6" />
    </Svg>
  )
}

export function UndoIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M9 7 5 11l4 4" />
      <path d="M5 11h9.5a4.5 4.5 0 0 1 0 9H12" />
    </Svg>
  )
}

export function RedoIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="m15 7 4 4-4 4" />
      <path d="M19 11H9.5a4.5 4.5 0 0 0 0 9H12" />
    </Svg>
  )
}

/** Two faces meeting at a shared edge: interzone surface matching. */
export function MatchingIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M3.5 6 10 4v14l-6.5 2z" />
      <path d="M20.5 6 14 4v14l6.5 2z" />
      <path d="M10 11h4M12.2 9.2 14 11l-1.8 1.8M11.8 9.2 10 11l1.8 1.8" />
    </Svg>
  )
}

export function SelectIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M6 3.5 18 12l-5.2 1.3L15.5 19l-2.3 1-2.7-5.7L6 18z" />
    </Svg>
  )
}

/** A polygon with one vertex handle highlighted. */
export function VertexIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M5 18 4 8l8-4 8 6-3 9z" />
      <rect x="15" y="16.5" width="4" height="4" fill="currentColor" />
      <circle cx="4" cy="8" r="1.2" fill="currentColor" />
      <circle cx="12" cy="4" r="1.2" fill="currentColor" />
    </Svg>
  )
}

/** A building corner in plan, dragged diagonally. */
export function CornerIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M4 20V9h9v11" strokeDasharray="2 2" />
      <path d="M4 20V5h13v15z" />
      <rect x="15" y="3" width="4" height="4" fill="currentColor" />
      <path d="M20.5 1.5 22 3" />
    </Svg>
  )
}

/** Pencil over a zone outline. */
export function DrawZoneIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M3 20h11V9H3z" strokeDasharray="2.5 2" />
      <path d="m14.5 13.5 6-6a1.4 1.4 0 0 0-2-2l-6 6-.8 2.8z" />
    </Svg>
  )
}

export function MagnetIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M6 4v8a6 6 0 0 0 12 0V4" />
      <path d="M6 4h3v8a3 3 0 0 0 6 0V4h3M6 8h3M15 8h3" />
    </Svg>
  )
}

export function WindowIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <rect x="4" y="4" width="16" height="16" rx="1" />
      <path d="M12 4v16M4 12h16" />
    </Svg>
  )
}

export function DoorIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M3 21h18M6 21V3h12v18" />
      <circle cx="15" cy="12" r="1" fill="currentColor" />
    </Svg>
  )
}

export function MoveIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M12 3v18M3 12h18" />
      <path d="m9.5 5.5 2.5-2.5 2.5 2.5M9.5 18.5 12 21l2.5-2.5M5.5 9.5 3 12l2.5 2.5M18.5 9.5 21 12l-2.5 2.5" />
    </Svg>
  )
}

export function DeleteIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5" />
    </Svg>
  )
}

export function LinkIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </Svg>
  )
}

export function ImageIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m21 16-5-5-8 8" />
    </Svg>
  )
}

/** Three stacked slabs: stories. */
export function StoriesIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="m12 3 9 4-9 4-9-4z" />
      <path d="m3 12 9 4 9-4M3 16.5l9 4 9-4" />
    </Svg>
  )
}
