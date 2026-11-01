import type { SVGProps } from 'react'

/** 设置页用的小图标：内联 SVG，不引入图标库。 */
type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function base({ size = 18, ...rest }: IconProps): SVGProps<SVGSVGElement> {
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
    ...rest
  }
}

export function IconModels(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z" />
      <path d="m4 7.5 8 4.5 8-4.5" />
      <path d="M12 12v9" />
    </svg>
  )
}

export function IconTools(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M14.7 6.3a4 4 0 1 0 5 5L21 9l-3-3-1.3 1.3h-2Z" />
      <path d="m10 14-7 7" />
      <path d="m3 21 1.2-3.8L14 7.5" />
    </svg>
  )
}

export function IconText(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 5h16" />
      <path d="M4 12h10" />
      <path d="M4 19h13" />
    </svg>
  )
}

export function IconPalette(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 3a9 9 0 1 0 0 18c1.2 0 1.8-.8 1.8-1.8 0-1.2-1-1.6-1-2.7 0-.9.7-1.5 1.7-1.5H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8Z" />
      <circle cx="7.5" cy="11" r="1" />
      <circle cx="10" cy="7" r="1" />
      <circle cx="15" cy="7.5" r="1" />
    </svg>
  )
}

export function IconInfo(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </svg>
  )
}

export function IconMemory(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 4a4 4 0 0 0-4 4v.5A3.5 3.5 0 0 0 5 12a3.5 3.5 0 0 0 3 3.5V16a4 4 0 0 0 8 0v-.5A3.5 3.5 0 0 0 19 12a3.5 3.5 0 0 0-3-3.5V8a4 4 0 0 0-4-4Z" />
      <path d="M9 10h6" />
      <path d="M9 14h6" />
    </svg>
  )
}

export function IconZones(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3.5" y="4" width="7" height="7" rx="1.4" />
      <rect x="13.5" y="4" width="7" height="7" rx="1.4" />
      <rect x="3.5" y="13" width="7" height="7" rx="1.4" />
      <path d="M13.5 16.5h7" />
      <path d="M17 13v7" />
    </svg>
  )
}

export function IconQq(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7A2.5 2.5 0 0 1 17.5 16H9l-4 3.5V16H6.5A2.5 2.5 0 0 1 4 13.5v-7Z" />
      <path d="M9 9.5h.01" />
      <path d="M12 9.5h.01" />
      <path d="M15 9.5h.01" />
    </svg>
  )
}

export function IconPlus(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  )
}

export function IconTrash(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 7h16" />
      <path d="M9 7V5h6v2" />
      <path d="M6 7l1 13h10l1-13" />
    </svg>
  )
}

export function IconPencil(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 20h4L20 8l-4-4L4 16v4Z" />
      <path d="m14 5 4 4" />
    </svg>
  )
}

export function IconRefresh(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M20 12a8 8 0 1 1-2.4-5.7" />
      <path d="M20 4v5h-5" />
    </svg>
  )
}

export function IconBack(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M15 5l-7 7 7 7" />
    </svg>
  )
}

export function IconSpark(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 3v4" />
      <path d="M12 17v4" />
      <path d="M3 12h4" />
      <path d="M17 12h4" />
      <path d="m6.3 6.3 2.8 2.8" />
      <path d="m14.9 14.9 2.8 2.8" />
      <path d="m17.7 6.3-2.8 2.8" />
      <path d="m9.1 14.9-2.8 2.8" />
    </svg>
  )
}

export function IconSave(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M5 4h11l3 3v13H5V4Z" />
      <path d="M8 4v6h7V4" />
      <path d="M8 14h8v6H8z" />
    </svg>
  )
}
