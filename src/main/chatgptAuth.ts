import { createHash, createPublicKey, randomBytes, randomUUID, verify, type JsonWebKey } from 'node:crypto'
import { createServer } from 'node:http'
import { app, net, safeStorage, shell } from 'electron'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const OPENAI_RESOURCE = 'https://api.openai.com/v1'
export const CHATGPT_PROVIDER_ID = 'chatgpt-subscription'
const issuer = 'https://auth.openai.com'
const scope = 'chatgpt.tokens.use.direct'
const callbackPath = '/auth/callback'

interface TokenResponse {
  access_token: string
  refresh_token: string
  id_token?: string
  expires_in: number
  scope: string
  token_type: string
}

interface Session {
  clientId: string
  subject: string
  idToken: string
  accessToken: string
  refreshToken: string
  expiresAt: number
}

const sessionPath = () => join(app.getPath('userData'), 'chatgpt-session.bin')
let pending: Promise<unknown> | undefined

async function readSession(): Promise<Session | null> {
  try {
    return JSON.parse(safeStorage.decryptString(await readFile(sessionPath()))) as Session
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error('无法读取 ChatGPT 授权，请断开连接后重新登录。')
  }
}

async function saveSession(session: Session): Promise<void> {
  const temporary = sessionPath() + '.tmp'
  await writeFile(temporary, safeStorage.encryptString(JSON.stringify(session)), { mode: 0o600 })
  await rename(temporary, sessionPath())
}

async function hostId(): Promise<string> {
  const path = join(app.getPath('userData'), 'chatgpt-host-id')
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const id = 'urn:uuid:' + randomUUID()
    await writeFile(path, id, { flag: 'wx', mode: 0o600 })
    return id
  }
}

async function exchange(params: Record<string, string>): Promise<TokenResponse> {
  const response = await net.fetch(issuer + '/api/accounts/oauth/token', {
    method: 'POST',
    redirect: 'error',
    body: new URLSearchParams({ ...params, resource: OPENAI_RESOURCE }),
    signal: AbortSignal.timeout(20_000)
  })
  if (!response.ok) throw new Error(`ChatGPT 授权失败（HTTP ${response.status}），请重新登录。`)
  const tokens = await response.json() as TokenResponse
  if (typeof tokens.scope !== 'string' || !tokens.scope.split(/\s+/).includes(scope)) {
    throw new Error('ChatGPT 尚未授予使用订阅额度的权限。')
  }
  if (!tokens.access_token || !tokens.refresh_token || !Number.isFinite(tokens.expires_in) ||
      tokens.expires_in <= 0 || tokens.token_type?.toLowerCase() !== 'bearer') {
    throw new Error('ChatGPT 返回的授权凭据不完整。')
  }
  return tokens
}

async function validateIdentity(token: string, clientId: string, nonce: string): Promise<string> {
  const [header, payload, signature, extra] = token.split('.')
  if (!header || !payload || !signature || extra !== undefined) throw new Error('无效的 ChatGPT 身份令牌。')
  const { alg, kid } = JSON.parse(Buffer.from(header, 'base64url').toString())
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
  const now = Date.now() / 1000
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (alg !== 'RS256' || typeof kid !== 'string' || claims.iss !== issuer ||
      !audiences.includes(clientId) || (audiences.length > 1 && claims.azp !== clientId) ||
      (claims.azp !== undefined && claims.azp !== clientId) ||
      !Number.isFinite(claims.exp) || claims.exp <= now || !Number.isFinite(claims.iat) ||
      claims.iat > now + 5 || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + 5)) ||
      claims.nonce !== nonce || typeof claims.sub !== 'string' || !claims.sub) {
    throw new Error('ChatGPT 身份验证失败。')
  }
  const response = await net.fetch(issuer + '/.well-known/jwks.json', {
    redirect: 'error', signal: AbortSignal.timeout(20_000)
  })
  if (!response.ok) throw new Error('无法获取 ChatGPT 签名密钥。')
  const { keys } = await response.json() as { keys: Array<JsonWebKey & { kid: string; alg?: string }> }
  const key = keys.find((item) => item.kid === kid && item.kty === 'RSA' && (!item.alg || item.alg === alg))
  if (!key || !verify('RSA-SHA256', Buffer.from(header + '.' + payload),
    createPublicKey({ key, format: 'jwk' }), Buffer.from(signature, 'base64url'))) {
    throw new Error('ChatGPT 身份签名验证失败。')
  }
  return claims.sub
}

async function authorize(): Promise<Session> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用。')
  const previous = await readSession()
  const externalHostId = await hostId()
  const state = randomBytes(32).toString('base64url')
  const nonce = randomBytes(32).toString('base64url')
  const verifier = randomBytes(32).toString('base64url')
  const server = createServer()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('无法启动 ChatGPT 登录回调。')
    const redirect = `http://127.0.0.1:${address.port}${callbackPath}`
    const callback = new Promise<URLSearchParams>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('ChatGPT 登录超时，请重试。')), 180_000)
      server.once('error', reject)
      server.on('request', (request, response) => {
        if (request.method !== 'GET' || !request.url?.startsWith(callbackPath + '?')) {
          response.writeHead(404).end()
          return
        }
        const url = new URL('http://127.0.0.1' + request.url)
        if (url.pathname !== callbackPath ||
            url.searchParams.get('state') !== state) {
          response.writeHead(400).end()
          return
        }
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
          .end('Return to Margin to see the sign-in result.')
        resolve(url.searchParams)
      })
    })
    const url = new URL(issuer + '/api/accounts/authorize')
    url.search = new URLSearchParams({
      client_id: previous?.clientId ?? 'dynamic_agent_client',
      ...(previous ? { id_token_hint: previous.idToken } : { agent_name_hint: 'Margin' }),
      ext_agent_host_id: externalHostId,
      response_type: 'code',
      redirect_uri: redirect,
      scope: 'openid profile email offline_access resource.invoke ' + scope,
      resource: OPENAI_RESOURCE,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url')
    }).toString()
    const [params] = await Promise.all([callback, shell.openExternal(url.href)])
    const code = params.get('code')
    const clientId = params.get('client_id') ?? previous?.clientId
    if (params.has('error') || !code || !clientId || clientId === 'dynamic_agent_client' ||
        (previous && clientId !== previous.clientId)) {
      throw new Error('ChatGPT 登录取消或授权未完成。')
    }
    const tokens = await exchange({
      grant_type: 'authorization_code', client_id: clientId,
      code, code_verifier: verifier, redirect_uri: redirect
    })
    if (!tokens.id_token) throw new Error('ChatGPT 未返回身份令牌。')
    const subject = await validateIdentity(tokens.id_token, clientId, nonce)
    if (previous && subject !== previous.subject) throw new Error('ChatGPT 登录账号与已连接账号不同。')
    return {
      clientId, subject, idToken: tokens.id_token,
      accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000
    }
  } finally {
    clearTimeout(timer)
    server.close()
    server.closeAllConnections()
  }
}

function updateSession<T>(operation: () => Promise<T>): Promise<T> {
  const next = Promise.resolve(pending).catch(() => undefined).then(operation)
  pending = next
  void next.finally(() => { if (pending === next) pending = undefined }).catch(() => undefined)
  return next
}

let signingIn = false

export async function connectChatGPT(): Promise<void> {
  if (signingIn) throw new Error('ChatGPT 登录已在进行中。')
  signingIn = true
  try {
    await updateSession(async () => saveSession(await authorize()))
  } finally {
    signingIn = false
  }
}

export async function disconnectChatGPT(): Promise<void> {
  if (signingIn) throw new Error('请等待当前 ChatGPT 登录结束。')
  await updateSession(() => rm(sessionPath(), { force: true }))
}

export async function hasChatGPTSession(): Promise<boolean> {
  return Boolean(await readSession().catch(() => null))
}

export async function chatGPTAccessToken(): Promise<string | null> {
  if (signingIn) throw new Error('请等待当前 ChatGPT 登录结束。')
  return updateSession(async () => {
    const session = await readSession()
    if (!session) return null
    if (session.expiresAt > Date.now() + 30_000) return session.accessToken
    const tokens = await exchange({
      grant_type: 'refresh_token', client_id: session.clientId, refresh_token: session.refreshToken
    })
    await saveSession({
      ...session, accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000
    })
    return tokens.access_token
  })
}