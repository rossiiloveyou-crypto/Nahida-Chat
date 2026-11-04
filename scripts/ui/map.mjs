#!/usr/bin/env node
/**
 * ui:map 的启动器（P2 新增）。
 *
 * 为什么不直接在 package.json 里串两条命令：
 * 需要用 **同一组参数** 去跑「出图」和「重写文档」，而 pnpm 只会把 argv 追加到最后一条命令后面。
 * 这里转发一次，保证 `pnpm ui:map --only=settings-tools` 两步拿到的是同一份筛选条件。
 *
 * 用法：
 *   pnpm ui:map                                  全量（默认，慢）
 *   pnpm ui:map --only=settings-tools            只拍这一张（坐标表合并上一次的）
 *   pnpm ui:map --only=settings-tools,settings-channels   几张
 *   pnpm ui:map --only=diff                      只拍上次之后有变化的
 *   pnpm ui:map --only=settings-tools --theme=dark       其它参数照样透传
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..', '..')
const forwarded = process.argv.slice(2)

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: projectRoot })
  return result.status ?? 1
}

// 版本号只在 main 里用（按 package.json 的 major 写产物文件名），这里读同一份
const version = (JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version || '1').split('.')[0]
const reportJson = path.join('docs', 'ui', 'ui-map-v' + version + '.json')

const electronBin = require('electron') // 这个包导出的就是可执行文件路径
const exitCode = run(electronBin, ['scripts/ui/generate-ui-map.cjs', ...forwarded])
if (exitCode !== 0) process.exit(exitCode)

process.exit(run(process.execPath, ['scripts/ui/write-ui-map-md.cjs', reportJson]))
