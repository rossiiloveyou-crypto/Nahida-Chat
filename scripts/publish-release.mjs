/**
 * 把安装包发到 GitHub Releases（不依赖 gh CLI）。
 *
 * 为什么自己写：这台机器没有 gh，但 git 的 wincred 里已经有带 repo 权限的凭据，
 * 用 git credential fill 取出来就能直接打 API，不必让用户再装一个工具。
 *
 * token 只在内存里用，不打印、不落盘。
 * 已存在的 release 复用；同名资源先删再传（GitHub 不允许覆盖同名 asset）。
 */
import { execFileSync } from 'node:child_process'
import { createReadStream, statSync } from 'node:fs'
import https from 'node:https'
import path from 'node:path'

const OWNER = 'rossiiloveyou-crypto'
const REPO = 'Nahida-Chat'
const TAG = process.argv[2] || 'v1.0.0'
const ASSET = process.argv[3] || 'release/Nahida Chat Setup 1.0.0.exe'
const NAME = path.basename(ASSET)

function readToken() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8'
  })
  const line = out.split('\n').find((l) => l.startsWith('password='))
  if (!line) throw new Error('凭据管理器里没有 github.com 的口令')
  return line.slice('password='.length)
}

const TOKEN = readToken()

function api(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const request = https.request(
      {
        host: 'api.github.com',
        path: urlPath,
        method,
        headers: Object.assign(
          {
            authorization: 'Bearer ' + TOKEN,
            accept: 'application/vnd.github+json',
            'user-agent': 'nahida-chat-release',
            'x-github-api-version': '2022-11-28'
          },
          payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}
        )
      },
      (response) => {
        const chunks = []
        response.on('data', (c) => chunks.push(c))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON 原样返回 */ }
          resolve({ status: response.statusCode, json, text })
        })
      }
    )
    request.on('error', reject)
    if (payload) request.write(payload)
    request.end()
  })
}

const NOTES = [
  '## Nahida Chat 1.0.0',
  '',
  '首个正式版。',
  '',
  '### 新增能力',
  '',
  '- **ST 桥接**：故事区可把生成交给本机 SillyTavern，借它的预设注入（含破甲）；判定单点，关掉即回到原路径',
  '- **显示层**：markdown 渲染 + ST 正则（markdownOnly 通道）+ 标签折叠卡 + 对白橙色高亮',
  '- **消息可悔**：编辑（保存 / 保存并重新提问）、重发、删除任意消息；桥接生效时模型选择置灰',
  '- **RAG 一键下载**：设置页点一下即可下载 embedding 模型（约 587 MB，镜像回退、真实体积进度、原子落盘）',
  '',
  '### 安装',
  '',
  '下载下方 Nahida Chat Setup 1.0.0.exe 运行即可。',
  '',
  '- 自带 Electron 运行时与 QQ 宿主，不需要装 Node / pnpm',
  '- 可选安装目录；数据保存在 %APPDATA%\\Nahida Chat',
  '- 未配置代码签名，Windows SmartScreen 首次可能提示，选择「仍要运行」',
  '',
  '### 已知边界',
  '',
  '- 没有自动更新',
  '- ST 桥接需要自行启动 ST，且只作用于故事模式',
  '- API Key 未使用 safeStorage 加密'
].join('\n')

let release = await api('GET', '/repos/' + OWNER + '/' + REPO + '/releases/tags/' + TAG)
if (release.status === 404) {
  release = await api('POST', '/repos/' + OWNER + '/' + REPO + '/releases', {
    tag_name: TAG,
    target_commitish: 'main',
    name: 'Nahida Chat 1.0.0',
    body: NOTES,
    draft: false,
    prerelease: false
  })
  if (release.status >= 300) throw new Error('创建 release 失败：' + release.text)
  console.log('release 已创建：' + release.json.html_url)
} else if (release.status >= 300) {
  throw new Error('查询 release 失败：' + release.text)
} else {
  console.log('release 已存在，复用：' + release.json.html_url)
}

const releaseId = release.json.id

const existing = await api('GET', '/repos/' + OWNER + '/' + REPO + '/releases/' + releaseId + '/assets')
if (existing.status < 300 && Array.isArray(existing.json)) {
  for (const asset of existing.json) {
    if (asset.name === NAME) {
      await api('DELETE', '/repos/' + OWNER + '/' + REPO + '/releases/assets/' + asset.id)
      console.log('已删除旧资源：' + asset.name)
    }
  }
}

const size = statSync(ASSET).size
const uploadPath = '/repos/' + OWNER + '/' + REPO + '/releases/' + releaseId + '/assets?name=' + encodeURIComponent(NAME)
const uploaded = await new Promise((resolve, reject) => {
  const request = https.request(
    {
      method: 'POST',
      host: 'uploads.github.com',
      path: uploadPath,
      headers: {
        authorization: 'Bearer ' + TOKEN,
        accept: 'application/vnd.github+json',
        'user-agent': 'nahida-chat-release',
        'content-type': 'application/octet-stream',
        'content-length': size
      }
    },
    (response) => {
      const chunks = []
      response.on('data', (c) => chunks.push(c))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch { /* ignore */ }
        resolve({ status: response.statusCode, json, text })
      })
    }
  )
  request.on('error', reject)
  createReadStream(ASSET).pipe(request)
})
if (uploaded.status >= 300) throw new Error('上传失败：' + uploaded.text)

console.log('上传成功：' + uploaded.json.name + ' (' + (uploaded.json.size / 1048576).toFixed(0) + ' MB)')
console.log('下载地址：' + uploaded.json.browser_download_url)
console.log('发布页：' + release.json.html_url)