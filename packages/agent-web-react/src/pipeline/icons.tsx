// Icons of the pipeline editor, in the style of ../components/icons.tsx: inline SVG, the current
// text colour, no icon font.
import type { IconProps } from '../components/icons.js'

const base = (size = 16) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
})

export const TrashIcon = ({ size, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v5M14 11v5" />
  </svg>
)

export const FitIcon = ({ size, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" />
  </svg>
)

export const MinusIcon = ({ size, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M5 12h14" />
  </svg>
)

export const UploadIcon = ({ size, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M12 16V4M7 9l5-5 5 5M4 20h16" />
  </svg>
)

export const CodeIcon = ({ size, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14" />
  </svg>
)

export const PlayIcon = ({ size, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M7 4.5v15l12-7.5z" fill="currentColor" />
  </svg>
)

export const PlugIcon = ({ size, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" />
  </svg>
)

export const SkipIcon = ({ size, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="8" />
    <path d="m6.5 17.5 11-11" />
  </svg>
)
