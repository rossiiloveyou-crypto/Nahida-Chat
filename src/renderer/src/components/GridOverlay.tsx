import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'

/**
 * 网格调试覆盖层。
 * 目的：让"改这里"能被精确定位——8px 细线、64px 粗线、列标 A/B/C…、行标 1/2/3…，
 * 并给每个可标注元素画框编号。
 *
 * 开关：Ctrl/Cmd + Shift + G；也可以在 URL 上加 ?grid=1 或 #grid 强制打开。
 * 仅在开发/调试时使用，不参与任何业务逻辑。
 */

const CELL = 8
const MAJOR_EVERY = 8 // 64px 一条粗线

function columnLabel(index: number): string {
  let n = index
  let label = ''
  do {
    label = String.fromCharCode(65 + (n % 26)) + label
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return label
}

interface Region {
  label: string
  top: number
  left: number
  width: number
  height: number
}



interface Target {
  index: number
  tag: string
  top: number
  left: number
  width: number
  height: number
}

/**
 * 在渲染完成后扫描一份"可标注清单"：
 * 优先用显式的 data-ui-target 属性；没有就退化成主要布局块。
 * 这样新增区块只要加属性就会被自动编号，不用改这个组件。
 */
function collectTargets(root: HTMLElement): { regions: Region[]; targets: Target[] } {
  const explicitRegions = [...root.querySelectorAll<HTMLElement>('[data-ui-region]')]
  const regions = explicitRegions.map((node) => {
    const rect = node.getBoundingClientRect()
    return {
      label: node.dataset.uiRegion ?? '',
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height
    }
  })

  const explicitTargets = [...root.querySelectorAll<HTMLElement>('[data-ui-target]')]
  const targets = explicitTargets.map((node, index) => {
    const rect = node.getBoundingClientRect()
    return {
      index: index + 1,
      tag: node.dataset.uiTarget ?? node.tagName.toLowerCase(),
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height
    }
  })

  return { regions, targets }
}

export function GridOverlay() {
  const location = useLocation()
  const [enabled, setEnabled] = useState(() => {
    if (typeof window === 'undefined') return false
    return new URLSearchParams(window.location.search).has('grid') || window.location.hash.includes('grid')
  })
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [regions, setRegions] = useState<Region[]>([])
  const [targets, setTargets] = useState<Target[]>([])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'g') {
        event.preventDefault()
        setEnabled((value) => !value)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!enabled) return
    const root = document.documentElement

    const measure = (): void => {
      const shell = document.querySelector<HTMLElement>('.app-shell') ?? document.body
      setSize({ width: window.innerWidth, height: window.innerHeight })
      const collected = collectTargets(shell)
      setRegions(collected.regions)
      setTargets(collected.targets)
      // 让截图脚本能确认"这一帧已经是当前路由的量测结果"
      root.dataset.uiReady = location.pathname
      root.dataset.uiTargets = String(collected.targets.length)
    }

    measure()
    // 路由切换后 React 还没渲染完，量到的是上一页；补两次
    const first = window.setTimeout(measure, 0)
    const second = window.setTimeout(measure, 120)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
      window.clearTimeout(first)
      window.clearTimeout(second)
    }
  }, [enabled, location.pathname])

  if (!enabled) return null

  const columns: number[] = []
  for (let x = 0; x < size.width; x += CELL * MAJOR_EVERY) columns.push(x)

  const rows: number[] = []
  for (let y = 0; y < size.height; y += CELL * MAJOR_EVERY) rows.push(y)

  return (
    <div className="ui-grid" aria-hidden="true">
      {/* 细网格 8px */}
      <div
        className="ui-grid__fine"
        style={{
          backgroundImage:
            'repeating-linear-gradient(to right, rgba(40,120,200,0.16) 0 1px, transparent 1px ' +
            CELL +
            'px), repeating-linear-gradient(to bottom, rgba(40,120,200,0.16) 0 1px, transparent 1px ' +
            CELL +
            'px)'
        }}
      />
      {/* 粗网格 64px */}
      <div
        className="ui-grid__major"
        style={{
          backgroundImage:
            'repeating-linear-gradient(to right, rgba(200,60,40,0.34) 0 1px, transparent 1px ' +
            CELL * MAJOR_EVERY +
            'px), repeating-linear-gradient(to bottom, rgba(200,60,40,0.34) 0 1px, transparent 1px ' +
            CELL * MAJOR_EVERY +
            'px)'
        }}
      />

      {/* 列标 A/B/C…：行 1 的格子里 */}
      {columns.map((x, index) => (
        <div key={'col-' + x} className="ui-grid__col-label" style={{ left: x + 3, top: 2 }}>
          {columnLabel(index)}
        </div>
      ))}

      {/* 行标 1/2/3…：列 A 的格子里 */}
      {rows.map((y, index) => (
        <div key={'row-' + y} className="ui-grid__row-label" style={{ top: y + 2, left: 2 }}>
          {index + 1}
        </div>
      ))}

      {/* 区域框 A/B/C */}
      {regions.map((region) => (
        <div
          key={'region-' + region.label + region.top}
          className="ui-grid__region"
          style={{ top: region.top, left: region.left, width: region.width, height: region.height }}
        >
          <span className="ui-grid__region-label">
            {region.label.split(' ')[0]} · {region.label.split(' ').slice(1).join(' ')}
          </span>
        </div>
      ))}

      {/* 元素框 + 编号 */}
      {targets.map((target) => (
        <div
          key={'target-' + target.tag + target.top + target.left}
          className="ui-grid__target"
          style={{ top: target.top, left: target.left, width: target.width, height: target.height }}
        >
          <span
            className="ui-grid__target-label"
            style={target.top < 16 ? { top: 15 } : undefined}
          >
            {target.index}
          </span>
        </div>
      ))}

      <div className="ui-grid__hint">网格已开启 · Ctrl/Cmd + Shift + G 关闭</div>
    </div>
  )
}
