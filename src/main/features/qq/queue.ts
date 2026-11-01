/**
 * 按 key 串行的任务队列（P4 G2 / M5）。
 *
 * 语义与 `Cyrene-Agent-1.3.4/src/main/channels/keyed-queue.ts` 一致（E13），
 * 但自己实现（不引 Cyrene 依赖，约 50 行）。
 *
 * 四条不变量，少一条就会退化成"并发"或"卡死"：
 *  1. 同键串行：state.tail.then(task)
 *  2. 尾链吞错：失败不能让同键后续任务全部阻断
 *  3. 超限拒绝（reject，不是排队）：QQ 里堆 20 轮，用户等到的是 10 分钟前的答案
 *  4. 键空即删：防 Map 无限增长
 */

export interface KeyedQueue {
  run<T>(key: string, task: () => Promise<T>): Promise<T>
  /** 当前还有多少键在排队/执行（测试与面板用） */
  pendingKeys(): number
}

export interface KeyedQueueOptions {
  /** 单键最多同时挂多少个任务（含正在跑的那个）。默认 8。 */
  maxPendingPerKey?: number
}

interface KeyState {
  tail: Promise<void>
  pending: number
}

export function createKeyedQueue(options: KeyedQueueOptions = {}): KeyedQueue {
  const maxPending = Math.max(1, Math.floor(options.maxPendingPerKey ?? 8))
  const states = new Map<string, KeyState>()

  return {
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
      let state = states.get(key)
      if (!state) {
        state = { tail: Promise.resolve(), pending: 0 }
        states.set(key, state)
      }

      if (state.pending >= maxPending) {
        return Promise.reject(new Error('queue_full:' + key))
      }

      state.pending += 1
      // tail 永远只接一个 then：任务 B 排在 A 的完成（或失败）之后
      const result = state.tail.then(task)
      // 尾链吞错：A 抛了，B 仍要执行；但 result 本身保留 rejection 给调用方
      state.tail = result.then(
        () => undefined,
        () => undefined
      )

      return result.finally(() => {
        state.pending -= 1
        if (state.pending === 0 && states.get(key) === state) states.delete(key)
      })
    },
    pendingKeys(): number {
      return states.size
    }
  }
}
