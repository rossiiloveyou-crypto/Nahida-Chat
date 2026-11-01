import { READ_ONLY_LABEL, WRITE_LABEL } from '@shared/tools'
import type { ToolApprovalTicket } from '@shared/tools'

interface ApprovalCardProps {
  ticket: ToolApprovalTicket
  onRespond: (approved: boolean, remember: boolean) => void
}

export function ApprovalCard({ ticket, onRespond }: ApprovalCardProps) {
  return (
    <div className="approval">
      <div className="approval__head">
        <span className="approval__badge">
          {ticket.call.readOnly ? READ_ONLY_LABEL : WRITE_LABEL}
        </span>
        <strong className="approval__title">{ticket.call.title}</strong>
        <code className="approval__name">{ticket.call.name}</code>
      </div>
      <p className="approval__reason">{ticket.reason}</p>
      <pre className="approval__args">{ticket.call.arguments}</pre>
      <div className="approval__actions">
        <button className="btn-ghost" onClick={() => onRespond(false, false)}>
          拒绝
        </button>
        <button className="btn-ghost" onClick={() => onRespond(true, true)}>
          本会话总是允许
        </button>
        <button className="btn-primary" onClick={() => onRespond(true, false)}>
          允许这次
        </button>
      </div>
    </div>
  )
}
