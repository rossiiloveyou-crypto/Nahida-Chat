import { DEFAULT_PERSONA_ID, canUseCommand, normalizePersonaId } from '@shared/persona'
import type { CommandName } from '@shared/persona'
import { memoryService } from '../rag'
import type { CommandContext, CommandResult } from './types'

/**
 * P4：四条指令的实现（**这是唯一最终形态**）。
 *
 * 三条纪律：
 *  1. **不自己发消息**：sendText 在 createQqBridge 的闭包里，绑了 deps.host 与 stats。
 *     在这里抄一份 = 第二处发送实现（B2），而且第二份不会更新 stats.sent。
 *     所以执行器只返回 text，由 bridge 用既有 sendText 发。
 *  2. **不重判存储层的规则**：`deletePersona` 自己拒绝 default / 激活项，
 *     `upsertPersona` 自己保证 `SUM(is_active)=1`。这里只为了给**可读原因**而读一次，
 *     判定结果仍以被调方为准（两处各判一次必然漂移）。
 *  3. **不读盘、不碰 access.json**：等级与门槛都是入参。
 */

const USAGE: Record<CommandName, string> = {
  list: '用法：//list',
  switch: '用法：//switch 人设名',
  add: '用法：//add 人设名',
  dele: '用法：//dele 人设名'
}

/** 越权统一话术：**不暴露门槛等级**（暴露了就能被逐级试探） */
const DENIED = '你的指令权限不够，这条指令需要更高的等级。'

const NAME_RULE = '人设名只能用中文/字母/数字/下划线/连字符，1–32 字。'

function deny(): CommandResult {
  return { text: DENIED, detail: '指令被拒（等级不足）', ok: false }
}

function needArg(ctx: CommandContext, name: CommandName): CommandResult | null {
  if (ctx.args.length > 0) return null
  return { text: USAGE[name], detail: '缺参数', ok: false }
}

/** 解析人设名；非法时返回 null，由调用方给 NAME_RULE 文案 */
function personaOf(ctx: CommandContext): string | null {
  return normalizePersonaId(ctx.args[0])
}

export function runCommand(name: CommandName, ctx: CommandContext): CommandResult {
  if (!canUseCommand(ctx.level, name, ctx.thresholds)) return deny()

  if (name === 'list') {
    const rows = memoryService.listPersonas(ctx.userId)
    // 🔴 这条分支真会走到：用户只要还没说过话，P3 的 activePersonaOf 就还没给他注册 default
    if (rows.length === 0) {
      return { text: '你还没有人设。发「//add 名字」建一个。', detail: '无任何合法人设', ok: true }
    }
    const body = rows.map((row) => (row.isActive ? '★ ' : '· ') + row.personaId).join('\n')
    return { text: body, detail: '列出 ' + String(rows.length) + ' 个人设', ok: true }
  }

  if (name === 'switch') {
    const missing = needArg(ctx, name)
    if (missing) return missing
    const personaId = personaOf(ctx)
    if (!personaId) return { text: NAME_RULE, detail: '人设名不合法', ok: false }
    const rows = memoryService.listPersonas(ctx.userId)
    if (!rows.some((row) => row.personaId === personaId)) {
      // 🔴 不做「顺手建一个」：建人设是 //add 的职责，两个动作不许互相兜底
      return {
        text: '你没有人设「' + personaId + '」。先「//add ' + personaId + '」再切。',
        detail: '目标人设不存在',
        ok: false
      }
    }
    memoryService.upsertPersona(ctx.userId, personaId, true) // 原子：同事务清零再置 1
    return {
      text: '已切到人设「' + personaId + '」，下一句话就写进这里。',
      detail: '切到 ' + personaId,
      ok: true
    }
  }

  if (name === 'add') {
    const missing = needArg(ctx, name)
    if (missing) return missing
    const personaId = personaOf(ctx)
    if (!personaId) return { text: NAME_RULE, detail: '人设名不合法', ok: false }
    const rows = memoryService.listPersonas(ctx.userId)
    if (rows.some((row) => row.personaId === personaId)) {
      return {
        text: '人设「' + personaId + '」已经有了。要切过去用「//switch ' + personaId + '」。',
        detail: '已存在',
        ok: false
      }
    }
    memoryService.upsertPersona(ctx.userId, personaId, false) // 🔴 activate=false：add 不改变激活项
    return {
      text: '已新建人设「' + personaId + '」（当前仍是原来的激活人设）。',
      detail: '新建 ' + personaId,
      ok: true
    }
  }

  // name === 'dele'
  const missing = needArg(ctx, name)
  if (missing) return missing
  const personaId = personaOf(ctx)
  if (!personaId) return { text: NAME_RULE, detail: '人设名不合法', ok: false }
  // 为了给**可读原因**先读两次；但**判定仍以 deletePersona 的返回值为准**
  if (personaId === DEFAULT_PERSONA_ID) {
    return { text: '「default」是每个用户的兜底人设，不能删。', detail: '拒绝：default 不可删', ok: false }
  }
  if (memoryService.activePersona(ctx.userId) === personaId) {
    return {
      text: '「' + personaId + '」正在使用中。先「//switch」到别人设再删。',
      detail: '拒绝：目标是激活项',
      ok: false
    }
  }
  const ok = memoryService.deletePersona(ctx.userId, personaId)
  if (!ok) {
    return {
      text: '没删成：这条人设不存在，或者它是兜底项/正在使用中。',
      detail: '删除失败（store 拒绝）',
      ok: false
    }
  }
  return {
    text:
      '已删除人设「' + personaId + '」。\n' +
      '（这条人设名下的记忆与历史仍保留；要连记忆一起删，等记忆面板的「按人删除」。）',
    detail: '删除 ' + personaId,
    ok: true
  }
}

/**
 * 未知指令的文案（同文件导出，供 bridge 用）。
 *
 * 为什么单独一个函数：`parseCommand` 把「不认识」和「只有 //」都收成 `{ known:false }`，
 * 两者的文案只差一个名字，写在一处才不会漂。
 */
export function unknownCommandReply(name: string): CommandResult {
  const shown = name ? '「//' + name + '」' : '空的指令'
  return {
    text: shown + '不认识。可用：//list 看人设，//switch 切换，//add 新建，//dele 删除。',
    detail: '未知指令 ' + (name || '(空)'),
    ok: false
  }
}
