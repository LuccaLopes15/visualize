import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function base(size = 16, props: SVGProps<SVGSVGElement>): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    ...props
  }
}

export const IconSpark = ({ size, ...p }: IconProps): React.JSX.Element => (
  <svg {...base(size, p)}>
    <path d="M12 3l1.9 6.1L20 11l-6.1 1.9L12 19l-1.9-6.1L4 11l6.1-1.9z" fill="currentColor" stroke="none" />
  </svg>
)
export const IconHome = ({ size, ...p }: IconProps): React.JSX.Element => (
  <svg {...base(size, p)}>
    <path d="M4 11l8-6 8 6v8a1 1 0 0 1-1 1h-4v-5h-6v5H5a1 1 0 0 1-1-1z" />
  </svg>
)
export const IconList = ({ size, ...p }: IconProps): React.JSX.Element => (
  <svg {...base(size, p)}>
    <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
  </svg>
)
export const IconArchive = ({ size, ...p }: IconProps): React.JSX.Element => (
  <svg {...base(size, p)}>
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8M10 12h4" />
  </svg>
)
export const IconFolder = ({ size, ...p }: IconProps): React.JSX.Element => (
  <svg {...base(size, p)}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
)
export const IconSettings = ({ size, ...p }: IconProps): React.JSX.Element => (
  <svg {...base(size, p)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
)
export const IconSearch = ({ size, ...p }: IconProps): React.JSX.Element => (
  <svg {...base(size, p)}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </svg>
)
export const IconPlus = ({ size, ...p }: IconProps): React.JSX.Element => (
  <svg {...base(size, p)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)
export const IconX = ({ size, ...p }: IconProps): React.JSX.Element => (
  <svg {...base(size, p)}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
)
export const IconTrash = ({ size, ...p }: IconProps): React.JSX.Element => (
  <svg {...base(size, p)}>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
  </svg>
)
export const IconEdit = ({ size, ...p }: IconProps): React.JSX.Element => (
  <svg {...base(size, p)}>
    <path d="M4 20h4L19 9l-4-4L4 16z" />
  </svg>
)
export const IconStar = ({ size, filled, ...p }: IconProps & { filled?: boolean }): React.JSX.Element => (
  <svg {...base(size, p)}>
    <path
      d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"
      fill={filled ? 'currentColor' : 'none'}
    />
  </svg>
)
export const IconLink = ({ size, ...p }: IconProps): React.JSX.Element => (
  <svg {...base(size, p)}>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </svg>
)
export const IconRestore = ({ size, ...p }: IconProps): React.JSX.Element => (
  <svg {...base(size, p)}>
    <path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4" />
  </svg>
)
export const IconKeyboard = ({ size, ...p }: IconProps): React.JSX.Element => (
  <svg {...base(size, p)}>
    <rect x="2.5" y="6" width="19" height="12" rx="2" />
    <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
  </svg>
)
