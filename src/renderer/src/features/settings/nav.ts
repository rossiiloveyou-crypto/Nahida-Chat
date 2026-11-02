import type { ComponentType } from 'react'
import {
  IconChannels,
  IconInfo,
  IconMemory,
  IconModels,
  IconPalette,
  IconQq,
  IconText,
  IconTools,
  IconZones
} from './icons'

export type SettingsSectionId =
  | 'models'
  | 'prompts'
  | 'memory'
  | 'zones'
  | 'channels'
  | 'qq'
  | 'tools'
  | 'appearance'
  | 'about'

export interface SettingsNavItem {
  id: SettingsSectionId
  label: string
  description: string
  icon: ComponentType<{ size?: number }>
  /** 分组标题，只有第一项带标题 */
  group: string
}

/**
 * 设置页左侧导航。顺序 = 使用频率：先配模型，再管提示词与工具，
 * 外观和关于放最后。新增分区只需在这里加一行 + SettingsPage 里加一个 case。
 */
export const SETTINGS_NAV: SettingsNavItem[] = [
  {
    id: 'models',
    label: '模型配置',
    description: '服务商、密钥、模型清单',
    icon: IconModels,
    group: '基础设置'
  },
  {
    id: 'prompts',
    label: '系统提示词',
    description: '注入链路与文件',
    icon: IconText,
    group: '基础设置'
  },
  {
    id: 'memory',
    label: '长期记忆',
    description: '检索、查看与清理',
    icon: IconMemory,
    group: '能力与安全'
  },
  {
    id: 'zones',
    label: '区块',
    description: '记忆域与群绑定',
    icon: IconZones,
    group: '能力与安全'
  },
  {
    // P7：用户的操作链是「先划域（区块）→ 再授权谁能进这个域（渠道控制台）→ 最后看运行时状态（QQ 接入）」。
    // 放在 QQ 接入前面，符合「配置 → 运行」的阅读顺序。
    id: 'channels',
    label: '渠道控制台',
    description: '私聊 / 群聊的响应权限',
    icon: IconChannels,
    group: '能力与安全'
  },
  {
    id: 'qq',
    // P7：「绑定」概念已随 P6 删除，留着会让用户去找一个不存在的面板
    label: 'QQ 接入',
    description: '进程状态与出站行为',
    icon: IconQq,
    group: '能力与安全'
  },
  {
    id: 'tools',
    label: '工具权限',
    description: '只读 / 审批 / 完全访问',
    icon: IconTools,
    group: '能力与安全'
  },
  {
    id: 'appearance',
    label: '外观',
    description: '主题与排版',
    icon: IconPalette,
    group: '其他'
  },
  {
    id: 'about',
    label: '关于',
    description: '版本与运行环境',
    icon: IconInfo,
    group: '其他'
  }
]

export function isSettingsSectionId(value: string | undefined): value is SettingsSectionId {
  return Boolean(value) && SETTINGS_NAV.some((item) => item.id === value)
}

export function settingsNavItem(id: SettingsSectionId): SettingsNavItem {
  return SETTINGS_NAV.find((item) => item.id === id) ?? SETTINGS_NAV[0]
}