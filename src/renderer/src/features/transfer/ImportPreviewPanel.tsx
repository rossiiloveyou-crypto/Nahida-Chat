import type { ImportPreview } from '@shared/transfer'

export function ImportPreviewPanel({ preview }: { preview: ImportPreview }) {
  return <section className="transfer-preview" data-ui-target="导入预览" aria-label="文件解析预览">
    <strong>{preview.fileName} · {preview.format === 'st' ? '酒馆 JSONL' : 'NC 备份'}</strong>
    <p>{preview.sessionCount} 个会话 · {preview.messageCount} 条消息 · 用户 {preview.roleCounts.user ?? 0} / 助手 {preview.roleCounts.assistant ?? 0} / 系统 {preview.roleCounts.system ?? 0}</p>
    <p>跳过坏行 {preview.skippedLines} 条 · 丢弃扩展字段 {Object.values(preview.discardedFields).reduce((sum, count) => sum + count, 0)} 次</p>
    {preview.duplicateCount > 0 && <p role="status">这个文件已导入过 {preview.duplicateCount} 次，确认后将创建独立副本。</p>}
    {!preview.characterMatched && <p className="story-dialog__error">未匹配到来源角色「{preview.characterName || '未命名'}」，请确认下方角色选项。</p>}
    <dl><dt>首条摘要</dt><dd>{preview.firstMessageSummary || '（空）'}</dd><dt>末条摘要</dt><dd>{preview.lastMessageSummary || '（空）'}</dd></dl>
  </section>
}
