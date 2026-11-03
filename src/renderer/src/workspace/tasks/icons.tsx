import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement> & { size?: number }

function base(size = 14, p: SVGProps<SVGSVGElement>): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    ...p
  }
}

export const IconChevron = ({ size, open, ...p }: P & { open?: boolean }): React.JSX.Element => (
  <svg {...base(size, p)} style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform .12s' }}>
    <path d="M9 6l6 6-6 6" />
  </svg>
)
export const IconRelayout = ({ size, ...p }: P): React.JSX.Element => (
  <svg {...base(size, p)}>
    <path d="M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5" />
  </svg>
)
export const IconDir = ({ size, vertical, ...p }: P & { vertical?: boolean }): React.JSX.Element => (
  <svg {...base(size, p)}>
    {vertical ? (
      <path d="M12 3v6M12 9H6v4M12 9h6v4M6 13v8M18 13v8" />
    ) : (
      <path d="M3 12h6M9 12V6h4M9 12v6h4M13 6h8M13 18h8" />
    )}
  </svg>
)
export const IconFit = ({ size, ...p }: P): React.JSX.Element => (
  <svg {...base(size, p)}>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </svg>
)
export const IconUp = ({ size, ...p }: P): React.JSX.Element => (
  <svg {...base(size, p)}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </svg>
)
export const IconDown = ({ size, ...p }: P): React.JSX.Element => (
  <svg {...base(size, p)}>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </svg>
)
