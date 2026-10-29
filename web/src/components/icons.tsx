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

export const ChartIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 20h16" />
    <path d="M7 16v-5M12 16V6M17 16v-8" />
  </Icon>
)

export const BellIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16Z" />
    <path d="M10 20.5a2 2 0 0 0 4 0" />
  </Icon>
)

export const SparkIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />
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

export const SearchIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.4-4.4" />
  </Icon>
)
