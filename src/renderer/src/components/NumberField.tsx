import { useEffect, useRef, useState } from 'react'
import { clampNumber, formatNumberDraft } from './numberFieldMath'

export interface NumberFieldProps {
  value: number
  min?: number
  max?: number
  step?: number
  /** 🔴 只传真正的「不可编辑」。存盘过程中**不要**传：一禁用就丢焦点，等于逼用户再点一次。 */
  disabled?: boolean
  className?: string
  /** 失焦 / 回车才回调，值已按 min/max 钳过 */
  onCommit: (value: number) => void
  /** 写到 data-ui-target（供可定位图编号） */
  uiTarget?: string
  title?: string
  ariaLabel?: string
}

/**
 * 设置页统一的数字输入框（替换裸 <input type="number">）。
 *
 * 修的就是两个老毛病：
 *  ①「点一下只能打一个字符」——旧写法每敲一键就 onCommit → 主进程归一化 → 回写设置 →
 *    输入框的 value 被换成钳过的值；而且存盘期间 `disabled={saving}` 会**直接把焦点踢掉**。
 *    于是每打一位都要再点一次框。
 *  ②「小于下限立刻被改写」——每键都钳，12 改 100 会变成 1 → 10 → 100，中间两次先被改成下限。
 *
 * 现在的规矩（也就是输入框该有的手感）：
 *  - 打字只改**本地草稿**：不提交、不钳、不格式化，光标不动；
 *  - **失焦或回车**才提交，提交时按 min/max 钳一次（空 / 非法则回退到原值）；
 *  - `Esc` 放弃本次输入；
 *  - 外部值变化（别人存了设置）只在**没在编辑时**同步进来，不会抢走你正在打的字。
 */
export function NumberField({
  value,
  min,
  max,
  step,
  disabled,
  className,
  onCommit,
  uiTarget,
  title,
  ariaLabel
}: NumberFieldProps) {
  const [draft, setDraft] = useState(() => formatNumberDraft(value))
  const [editing, setEditing] = useState(false)
  // Esc 的意图要跨过 blur 才能生效（blur 里读到的 DOM value 还是用户打的字）
  const cancelRef = useRef(false)

  useEffect(() => {
    // 只在没在编辑时同步：正在打字时用外部值覆盖 draft，会让光标跳回去
    if (!editing) setDraft(formatNumberDraft(value))
  }, [value, editing])

  const commit = (raw: string): void => {
    const next = clampNumber(raw, min, max, value)
    setDraft(formatNumberDraft(next))
    if (next !== value) onCommit(next)
  }

  return (
    <input
      type="number"
      className={className}
      min={min}
      max={max}
      step={step}
      value={draft}
      disabled={disabled}
      data-ui-target={uiTarget}
      title={title}
      aria-label={ariaLabel}
      onFocus={() => setEditing(true)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => {
        setEditing(false)
        if (cancelRef.current) {
          cancelRef.current = false
          setDraft(formatNumberDraft(value))
          return
        }
        commit(event.target.value)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur()
          return
        }
        if (event.key === 'Escape') {
          cancelRef.current = true
          setDraft(formatNumberDraft(value))
          event.currentTarget.blur()
        }
      }}
    />
  )
}
