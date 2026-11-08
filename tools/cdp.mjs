// 极简 CDP 客户端：只用 HTTP 端点找页面 + WebSocket 发 Runtime.evaluate。
// 故意不引第三方依赖（插件目录不该带 node_modules）。
const DEBUG_HOST = '127.0.0.1'

function httpJson(port, path, { method = 'GET', timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const request = globalThis.fetch(`http://${DEBUG_HOST}:${port}${path}`, {
      method,
      signal: AbortSignal.timeout(timeoutMs),
    })
    request
      .then(async (response) => {
        const text = await response.text()
        if (!response.ok) {
          reject(new Error(`CDP ${method} ${path} → ${response.status}：${text.slice(0, 200)}`))
          return
        }
        try {
          resolve(text === '' ? null : JSON.parse(text))
        } catch {
          resolve(text)
        }
      })
      .catch((error) => reject(new Error(`CDP 端口 ${port} 不可用：${error?.message ?? error}`)))
  })
}

/** 浏览器在跑就返回版本信息，否则 null。 */
export async function fetchVersion(port) {
  try {
    return await httpJson(port, '/json/version', { timeoutMs: 1500 })
  } catch {
    return null
  }
}

/** 当前所有页面（含 devtools 页）。 */
export async function listPages(port) {
  const list = await httpJson(port, '/json/list')
  return Array.isArray(list) ? list.filter((item) => item.type === 'page') : []
}

/** 新开一个页面；返回 { id, webSocketDebuggerUrl, url }。 */
export async function newPage(port, url) {
  const target = await httpJson(port, `/json/new?${encodeURIComponent(url)}`, { method: 'PUT', timeoutMs: 8000 })
  if (target === null || typeof target !== 'object' || typeof target.webSocketDebuggerUrl !== 'string') {
    throw new Error('CDP 新建页面失败：返回里没有 webSocketDebuggerUrl')
  }
  return target
}

export async function closePage(port, id) {
  try {
    await httpJson(port, `/json/close/${id}`, { timeoutMs: 3000 })
  } catch {
    // 页面可能已被用户手动关掉，忽略。
  }
}

/** 一条 CDP 连接，只实现「发命令等结果」。 */
export class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.id === undefined) return
      const waiter = this.pending.get(message.id)
      if (waiter === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) waiter.reject(new Error(`CDP ${waiter.method} 失败：${message.error.message}`))
      else waiter.resolve(message.result)
    })
    socket.addEventListener('close', () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error('CDP 连接已关闭'))
      this.pending.clear()
    })
  }

  /** 连到某个页面的 WebSocket（Node 22+ 自带 WebSocket）。 */
  static async connect(wsUrl, { timeoutMs = 10000 } = {}) {
    const socket = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接 CDP WebSocket 超时')), timeoutMs)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error(`连接 CDP WebSocket 失败：${wsUrl}`))
      })
    })
    return new Cdp(socket)
  }

  send(method, params = {}) {
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /** 在页面里求值；默认等 Promise。异常会带页面里的错误文本抛出来。 */
  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    })
    if (result?.exceptionDetails !== undefined) {
      const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '未知错误'
      throw new Error(`页面脚本出错：${text}`)
    }
    return result?.result?.value
  }

  async navigate(url) {
    await this.send('Page.enable')
    await this.send('Page.navigate', { url })
  }

  close() {
    try {
      this.socket.close()
    } catch {
      // 已经关了。
    }
  }
}

export { httpJson }
