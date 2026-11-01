/**
 * 中文友好的轻量分词，只服务于 FTS5 关键词检索。
 *
 * 为什么不用 jieba：nodejieba 是原生模块，要 electron-rebuild，
 * 和 ADR-0001「能不引原生模块就不引」冲突。这里用二元切分（bigram），
 * 对「记忆条目」这种一句话长度的短文本足够，且零依赖、可单测。
 *
 * 关键原因：SQLite FTS5 的 unicode61 分词器不切中文分句，
 * 一整句会被当成一个 token，导致「草神」这种词永远匹配不上。
 * 所以写入前先切成空格分隔的词串，检索时同样切，才能命中。
 */

/** 需要保留的英文/数字整体，避免 "gpt-4o" 被拆碎 */
const ASCII_WORD = /[a-zA-Z0-9_]+/g
const CJK = /[\u4e00-\u9fff]/

/**
 * 把文本切成 FTS5 可检索的词串。
 *
 * 中文策略：二元组 + 单字，两种都进索引。
 * - 只放二元组会导致「猫」这种单字查询命中不到「橘猫」所在的句子
 *   （实测发现：用户经常只打一个字，这是真实缺口，不是理论问题）。
 * - 单字会让索引膨胀约 1 倍，但记忆条目都在 300 字以内、量级几百条，
 *   SQLite FTS5 完全扛得住，这个代价值得。
 *
 * 查询侧另有取舍，见 toMatchQuery：单字查询才用单字，
 * 多字查询只用二元组，避免「的」「了」这类泛词把噪声全捞进来。
 */
export function tokenize(text: string, options?: { includeUnigrams?: boolean }): string[] {
  const includeUnigrams = options?.includeUnigrams ?? true
  if (!text) return []
  const tokens: string[] = []
  let i = 0
  const length = text.length

  while (i < length) {
    const ch = text[i]

    if (CJK.test(ch)) {
      // 收集连续的汉字段
      let j = i
      while (j < length && CJK.test(text[j])) j += 1
      const run = text.slice(i, j)
      if (run.length === 1) {
        tokens.push(run)
      } else {
        // 二元切分：任何两个字以上的词都能被覆盖到
        for (let k = 0; k + 1 < run.length; k += 1) {
          tokens.push(run.slice(k, k + 2))
        }
        // 单字同时进索引，保证「猫」这类单字查询命中「橘猫」
        if (includeUnigrams) {
          for (const char of run) tokens.push(char)
        }
      }
      i = j
      continue
    }

    // 非中文：用正则整体抓英文/数字，其余字符跳过（标点不参与检索）
    const rest = text.slice(i)
    const match = rest.match(ASCII_WORD)
    if (match && rest.startsWith(match[0])) {
      tokens.push(match[0].toLowerCase())
      i += match[0].length
      continue
    }
    i += 1
  }

  // 去重但保序，避免同一个字重复占 FTS 索引空间
  return [...new Set(tokens)]
}

/** 入库用的词串（空格分隔），直接喂 FTS5。索引侧始终带单字。 */
export function toIndexText(text: string): string {
  return tokenize(text, { includeUnigrams: true }).join(' ')
}

/**
 * 把用户查询转成 FTS5 MATCH 表达式。
 *
 * 关键取舍：查询侧不总是带单字。
 * - 查询本身就是单字（「猫」）：必须用单字，否则命中不了。
 * - 查询是多字（「我住在哪」）：只用二元组，避免「我」「在」这类
 *   高频单字把所有记忆都捞进来，让关键词分数失去区分度。
 */
export function toMatchQuery(query: string): string {
  const cjkLength = (query.match(/[\u4e00-\u9fff]/g) ?? []).length
  // 整体查询只有 1 个汉字时才放开单字，其余情况只用二元组以上的词
  const includeUnigrams = cjkLength <= 1
  const tokens = tokenize(query, { includeUnigrams })
  if (tokens.length === 0) return ''
  return tokens.map((token) => '"' + token.replace(/"/g, '""') + '"').join(' OR ')
}

/**
 * 粗估 token 数。用于注入预算，不追求精确：
 * 1 个汉字 ≈ 1 token，4 个英文字符 ≈ 1 token。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  const rest = text.length - cjk
  return cjk + Math.ceil(rest / 4)
}