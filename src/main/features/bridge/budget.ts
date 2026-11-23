import { estimateTokens } from '../rag/tokenize'

export interface BridgeBudgetMessage {
  role: string
  content: string
}

export interface BridgeBudgetInput<T extends BridgeBudgetMessage = BridgeBudgetMessage> {
  /** ST context minus response allowance. Includes the ST-side reserve. */
  budgetTotal: number
  stReserveTokens: number
  personaTokens: number
  /** Non-shrinkable NC sections, excluding persona and both RAG sections. */
  fixedTokens: number
  storyTokens: number
  memoryTokens: number
  messages: readonly T[]
}

export interface BridgeBudgetResult<T extends BridgeBudgetMessage = BridgeBudgetMessage> {
  ok: boolean
  reason?: 'fail:budget'
  failKind?: 'persona' | 'fixed' | 'protected-tail'
  message?: string
  /** Both names refer to the same retained contiguous suffix. Check ok before sending. */
  messages: T[]
  history: T[]
  storyTokens: number
  memoryTokens: number
  historySent: number
  historyDropped: number
  historyTokens: number
  protectedTokens: number
  budgetUsed: number
  budgetTotal: number
  stReserveTokens: number
  personaTokens: number
  fixedTokens: number
}

/** Same lightweight estimator as RAG, with SUP-05's 10% safety allowance. */
export function estimateBridgeTokens(text: string): number {
  return Math.ceil(estimateTokens(text) * 1.1)
}

function tokens(value: number, name: string, capacity = false): number {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(name + ' must be a finite non-negative token count')
  }
  return capacity ? Math.floor(value) : Math.ceil(value)
}

/**
 * Pure allocation only: no settings reads, RAG retrieval, mutation, I/O or generation.
 * Drop oldest history first. Only when the protected suffix cannot fit do we
 * reduce story RAG, then memory RAG. Persona and fixed sections never shrink.
 * Inputs for section sizes and returned RAG targets use safety-adjusted tokens.
 */
export function allocateBridgeBudget<T extends BridgeBudgetMessage>(
  input: BridgeBudgetInput<T>
): BridgeBudgetResult<T> {
  const budgetTotal = tokens(input.budgetTotal, 'budgetTotal', true)
  const stReserveTokens = tokens(input.stReserveTokens, 'stReserveTokens')
  const personaTokens = tokens(input.personaTokens, 'personaTokens')
  const fixedTokens = tokens(input.fixedTokens, 'fixedTokens')
  let storyTokens = tokens(input.storyTokens, 'storyTokens')
  let memoryTokens = tokens(input.memoryTokens, 'memoryTokens')
  const costs = input.messages.map((message) => estimateBridgeTokens(message.content))
  let protectedStart = input.messages.length
  for (let i = input.messages.length - 1; i >= 0; i -= 1) {
    if (input.messages[i].role === 'user') {
      protectedStart = i
      break
    }
  }
  // A caller without user messages still retains its newest message.
  if (protectedStart === input.messages.length && protectedStart > 0) protectedStart -= 1
  const protectedTokens = costs.slice(protectedStart).reduce((sum, cost) => sum + cost, 0)
  const fixedUsed = stReserveTokens + personaTokens + fixedTokens
  let excess = Math.max(0, fixedUsed + protectedTokens + storyTokens + memoryTokens - budgetTotal)
  const storyReduction = Math.min(storyTokens, excess)
  storyTokens -= storyReduction
  excess -= storyReduction
  memoryTokens -= Math.min(memoryTokens, excess)

  let start = protectedStart
  let historyTokens = protectedTokens
  const sectionTokens = fixedUsed + storyTokens + memoryTokens
  // Stop at the first non-fitting predecessor; never skip a hole in the timeline.
  while (start > 0 && sectionTokens + historyTokens + costs[start - 1] <= budgetTotal) {
    start -= 1
    historyTokens += costs[start]
  }
  const history = input.messages.slice(start)
  const budgetUsed = sectionTokens + historyTokens
  const result: BridgeBudgetResult<T> = {
    ok: budgetUsed <= budgetTotal,
    messages: history, history, storyTokens, memoryTokens,
    historySent: history.length, historyDropped: start, historyTokens, protectedTokens,
    budgetUsed, budgetTotal, stReserveTokens, personaTokens, fixedTokens
  }
  if (!result.ok) {
    result.reason = 'fail:budget'
    result.failKind = personaTokens > budgetTotal - stReserveTokens
      ? 'persona' : fixedUsed > budgetTotal ? 'fixed' : 'protected-tail'
    const cause = result.failKind === 'persona' ? '人格提示词过大' : '固定上下文与最新用户消息尾缀超出预算'
    result.message = cause + '：预算 ' + budgetTotal + '，已用 ' + budgetUsed
      + '；三项体积：人格 ' + personaTokens + '，故事RAG ' + storyTokens + '，记忆RAG ' + memoryTokens
      + '；固定段 ' + fixedTokens + '，ST预留 ' + stReserveTokens + '，保护尾缀 ' + protectedTokens
  }
  return result
}
