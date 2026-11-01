import { READ_ONLY_LABEL, WRITE_LABEL } from '@shared/tools'
import type { ToolCallRecord, ToolCallStatus } from '@shared/tools'

const STATUS_LABEL: Record<ToolCallStatus, string> = {
  awaiting: '等待审批',
  running: '执行中',
  ok: '已完成',
  error: '失败',
  denied: '已拒绝'
}

export function ToolCalls({ calls }: { calls: ToolCallRecord[] }) {
  if (calls.length === 0) return null

  return (
    <div className="tool-list">
      {calls.map((call) => (
        <details
          key={call.id}
          className={'tool-item tool-item--' + call.status}
          open={call.status === 'awaiting' || call.status === 'running'}
        >
          <summary className="tool-item__summary">
            <span className="tool-item__risk">
              {call.readOnly ? READ_ONLY_LABEL : WRITE_LABEL}
            </span>
            <span className="tool-item__name">{call.name}</span>
            <span className="tool-item__status">{STATUS_LABEL[call.status]}</span>
            {call.durationMs !== null && <span className="tool-item__time">{call.durationMs}ms</span>}
          </summary>
          <div className="tool-item__body">
            <div className="tool-item__label">参数</div>
            <pre className="tool-item__pre">{call.arguments}</pre>
            {call.result !== null && (
              <>
                <div className="tool-item__label">结果</div>
                <pre className="tool-item__pre tool-item__pre--result">{call.result}</pre>
              </>
            )}
            {call.error !== null && <div className="tool-item__error">{call.error}</div>}
          </div>
        </details>
      ))}
    </div>
  )
}
