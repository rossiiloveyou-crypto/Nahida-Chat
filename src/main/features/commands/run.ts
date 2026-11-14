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
 *  2. **`//switch` 不重判存储层的规则**：`upsertPersona` 自己保证 `SUM(is_active)=1`，
 *     这里只为了给**可读原因**而读一次 `listPersonas`。
 *     🔴 但 `//dele` 是**例外**（M25 之后）：它调 `deleteByPersona`，那个方法**零拒绝、返回条数**，
 *     所以 default / 存在性 / 激活项三道判断**只能**在指令层做 —— 不是重复判定，是唯一一处。
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
    const exists = rows.some((row) => row.personaId === personaId)
    // 🔴 2026-11-13 修正（M26）：`default` 是**语义上恒存在**的兜底人设（连 `//dele default` 都明确拒绝），
    //    它没被注册只说明这个用户从没走完一轮对话 —— 指令在 bridge 的 `ensureSession` 之前就 return 了，
    //    永远到不了 `runStream` → `activePersonaOf`，所以「只发过指令、没聊过天」的用户一个 default 都没有。
    //    因此**仅对 default** 放行自动注册；其它名字仍不自动建（建人设是 //add 的职责，两个动作不互相兜底）。
    if (!exists && personaId !== DEFAULT_PERSONA_ID) {
      return {
        text: '你没有人设「' + personaId + '」。先「//add ' + personaId + '」再切。',
        detail: '目标人设不存在',
        ok: false
      }
    }
    memoryService.upsertPersona(ctx.userId, personaId, true) // 原子：同事务清零再置 1；default 不存在时这一步顺带注册
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
  // 🔴 2026-11-13 修正（M26）：`default` 语义上恒存在 —— 它连「删」都拒绝，
  //    所以这条判断**放在存在性检查之前**：不能因为它还没注册就说「不存在，没什么可删的」。
  if (personaId === DEFAULT_PERSONA_ID) {
    return { text: '「default」是每个用户的兜底人设，不能删。', detail: '拒绝：default 不可删', ok: false }
  }
  // 🔴 2026-11-13 修正（M25）：改用 `deleteByPersona`（连记忆与历史一起删）。
  //    它返回的是**删掉的记忆条数**，不是布尔 —— 条数为 0 无法区分
  //    「删成功但本来就没记忆」与「这个人设根本不存在」，所以**存在性必须自己先查一次**。
  const rows = memoryService.listPersonas(ctx.userId)
  if (!rows.some((row) => row.personaId === personaId)) {
    return {
      text: '你没有人设「' + personaId + '」，没什么可删的。用「//list」看看现有哪些。',
      detail: '目标人设不存在',
      ok: false
    }
  }
  if (memoryService.activePersona(ctx.userId) === personaId) {
    return {
      text: '「' + personaId + '」正在使用中。先「//switch」到别人设再删。',
      detail: '拒绝：目标是激活项',
      ok: false
    }
  }
  // 🔴 2026-11-13 修正（M25）：用户拍板「删人设就要连记忆与历史一起删」（原来是只删注册行）。
  //    `deleteByPersona` 单事务删 persona_chat_history + memories + user_personas，**本身不做任何拒绝**，
  //    所以上面三道判断（default / 存在性 / 激活项）必须留在指令层。
  //    ⚠️ 能力边界：sessions.json 原始消息与 summaries.json 摘要清不掉（H-C-07），那是 P5 的事。
  const removed = memoryService.deletePersonaWithData(ctx.userId, personaId)
  return {
    text:
      '已删除人设「' + personaId + '」，连同它的 ' + String(removed) + ' 条记忆与全部聊天历史。',
    detail: '删除 ' + personaId + '（记忆 ' + removed + ' 条）',
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
