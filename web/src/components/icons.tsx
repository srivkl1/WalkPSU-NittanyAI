import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Icon({ size = 24, children, ...rest }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...rest}>
      {children}
    </svg>
  )
}

export const MapIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 4 3.6 6.2a1 1 0 0 0-.6.9v12.4a.5.5 0 0 0 .7.5L9 18l6 2 5.4-2.2a1 1 0 0 0 .6-.9V4.5a.5.5 0 0 0-.7-.5L15 6 9 4Z" />
    <path d="M9 4v14M15 6v14" />
  </Icon>
)

export const TrophyIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 4h8v6a4 4 0 0 1-8 0V4Z" />
    <path d="M16 6h3v1.5A3.5 3.5 0 0 1 15.6 11M8 6H5v1.5A3.5 3.5 0 0 0 8.4 11M12 14v4M8.5 20h7" />
  </Icon>
)

export const PersonIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
  </Icon>
)

export const PinIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 21s7-6.1 7-11.5a7 7 0 0 0-14 0C5 14.9 12 21 12 21Z" />
    <circle cx="12" cy="9.5" r="2.5" />
  </Icon>
)

export const ClockIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Icon>
)

export const PeopleIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="9" cy="8.5" r="3.5" />
    <path d="M2.5 19.5a6.5 6.5 0 0 1 13 0M16 5.2a3.5 3.5 0 0 1 0 6.6M18.5 14a6.5 6.5 0 0 1 3 5.5" />
  </Icon>
)

export const InfoIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.5M12 7.5v.01" strokeWidth={2.4} />
  </Icon>
)

export const LocateIcon = (p: IconProps) => (
  <Icon {...p} fill="currentColor" stroke="none">
    <path d="M12 2 4.5 20.3l.7.7L12 18l6.8 3 .7-.7z" />
  </Icon>
)

export const ChevronIcon = (p: IconProps) => (
  <Icon size={16} {...p} strokeWidth={2.5}>
    <path d="m9 5 7 7-7 7" />
  </Icon>
)

export const QrIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4" y="4" width="6" height="6" rx="1" />
    <rect x="14" y="4" width="6" height="6" rx="1" />
    <rect x="4" y="14" width="6" height="6" rx="1" />
    <path d="M14 14h2v2h-2zM18 18h2v2h-2zM14 18v2M18 14h2" />
  </Icon>
)

export const CheckIcon = (p: IconProps) => (
  <Icon {...p} strokeWidth={2.6}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Icon>
)

export const CrossIcon = (p: IconProps) => (
  <Icon {...p} strokeWidth={2.6}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
)

export const PlusIcon = (p: IconProps) => (
  <Icon {...p} strokeWidth={2.6}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
)

/** Shake-Off: a phone with motion lines. */
export const ShakeIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="8" y="3" width="8" height="18" rx="2" />
    <path d="M4 8v8M20 8v8M11 18h2" />
  </Icon>
)

/** Quick Draw: a lightning bolt. */
export const BoltIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13 2 4.5 13.5H12L11 22l8.5-11.5H12z" />
  </Icon>
)

/** Needle Rain: a needle falling through rain. */
export const NeedleIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 2v9" />
    <path d="m9 13 3 9 3-9" />
    <path d="M6 7.5 7.2 11M18 7.5 16.8 11" />
  </Icon>
)

/** Point to the Landmark: a compass. */
export const CompassIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="m15.5 8.5-2 5-5 2 2-5z" />
  </Icon>
)

export const SearchIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.4-4.4" />
  </Icon>
)
