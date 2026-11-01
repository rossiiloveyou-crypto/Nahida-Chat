import avatarLight from './avatar_transparent.png'
import avatarDark from './avatar_dark_transparent.png'
import emblemLight from './center_emblem_transparent.png'
import emblemDark from './center_emblem_dark_transparent.png'
import sendLight from './icon-send.svg'
import sendDark from './icon-send-dark.svg'
import bgDark from './background_dark.png'
import sidebarBottomLight from './sidebar_bottom_bg.png'
import sidebarBottomDark from './sidebar_bottom_bg_dark.png'
import dividerLight from './divider-horizontal.svg'
import dividerDark from './divider-horizontal-dark.svg'

/**
 * 品牌素材统一出口（P2 白名单 11 个文件，见 PHASE-2 §4.1）。
 *
 * 为什么用 import 而不是写死字符串路径：Vite 只对 import 显式引用的资源做
 * 哈希与产物拷贝；写 '/assets/xxx.png' 这种字符串在打包后会 404（开发态却能跑）。
 * 经验库 A48：只在字符串里的契约，断了没人报警。
 *
 * 注意：CSS 里的 url() 不走这里（CSS 无法 import），见 global.css 的注释；
 * 那几处必须用 build 产物验证（PHASE-2 §六 A5）。
 */
export const BRAND = {
  avatar: { light: avatarLight, dark: avatarDark },
  emblem: { light: emblemLight, dark: emblemDark },
  send: { light: sendLight, dark: sendDark },
  /** 只在夜间使用（M2：日间保持纯色画布） */
  bgDark,
  sidebarBottom: { light: sidebarBottomLight, dark: sidebarBottomDark },
  divider: { light: dividerLight, dark: dividerDark }
} as const

/** 按主题取图：resolve 只可能是这两个值，写成函数避免每处重复三元表达式 */
export function brandFor(theme: 'light' | 'dark') {
  return theme === 'dark'
    ? { avatar: BRAND.avatar.dark, emblem: BRAND.emblem.dark, send: BRAND.send.dark }
    : { avatar: BRAND.avatar.light, emblem: BRAND.emblem.light, send: BRAND.send.light }
}
