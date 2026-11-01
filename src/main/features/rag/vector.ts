/**
 * 向量工具。向量以 Float32Array 存进 SQLite BLOB，
 * 检索时暴力算余弦——这个选择是量过的，不是偷懒：
 *
 * 1024 维 × 20000 条全量点积实测约 20ms。
 * 单用户桌面场景的记忆量级远小于此，引 ANN 索引（sqlite-vec 等）
 * 只会多一个原生模块和一次 electron-rebuild 的风险，没有收益。
 */

/** 把向量归一化，之后余弦相似度 = 点积，省掉每次开方 */
export function normalize(vec: Float32Array): Float32Array {
  let sum = 0
  for (let i = 0; i < vec.length; i += 1) sum += vec[i] * vec[i]
  const norm = Math.sqrt(sum)
  if (norm === 0) return vec
  const out = new Float32Array(vec.length)
  for (let i = 0; i < vec.length; i += 1) out[i] = vec[i] / norm
  return out
}

/** 余弦相似度。入参假定已归一化，直接点积。 */
export function cosine(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length)
  let dot = 0
  for (let i = 0; i < length; i += 1) dot += a[i] * b[i]
  return dot
}

/** Float32Array -> Buffer，直接按内存视图走，不做逐元素拷贝 */
export function toBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength)
}

/** BLOB -> Float32Array。注意必须对齐拷贝，不能直接套 buffer（Node 的 BLOB 可能是共享池） */
export function fromBlob(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob.byteLength)
  copy.set(blob)
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4)
}
