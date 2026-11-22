import { app, safeStorage } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'

interface CredentialFile {
  keys: Record<string, string>
}

function credentialPath(): string {
  return path.join(app.getPath('userData'), 'api-credentials.json')
}

async function readStore(): Promise<CredentialFile> {
  try {
    const raw = await fs.readFile(credentialPath(), 'utf8')
    const parsed = JSON.parse(raw) as CredentialFile
    return parsed?.keys ? parsed : { keys: {} }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { keys: {} }
    throw new Error('无法读取本地 API 密钥文件。')
  }
}

async function writeStore(store: CredentialFile): Promise<void> {
  const file = credentialPath()
  const temp = `${file}.tmp`
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(temp, JSON.stringify(store), 'utf8')
  await fs.rename(temp, file)
}

export async function hasApiKey(providerId: string): Promise<boolean> {
  return Boolean(await getApiKey(providerId))
}

export async function getApiKey(providerId: string): Promise<string | null> {
  try {
    const store = await readStore()
    const encrypted = store.keys[providerId]
    if (!encrypted) return null
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch {
    return null
  }
}

let pendingWrite = Promise.resolve()

function updateStore(change: (store: CredentialFile) => void): Promise<void> {
  const operation = pendingWrite.then(async () => {
    const store = await readStore()
    change(store)
    await writeStore(store)
  })
  pendingWrite = operation.catch(() => undefined)
  return operation
}

export async function saveApiKey(providerId: string, key: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('当前系统无法安全保存 API Key，已拒绝明文存储。')
  }
  const encrypted = safeStorage.encryptString(key.trim()).toString('base64')
  await updateStore((store) => { store.keys[providerId] = encrypted })
}

export async function clearApiKey(providerId: string): Promise<void> {
  await updateStore((store) => { delete store.keys[providerId] })
}

export async function listConfiguredProviders(): Promise<string[]> {
  const store = await readStore()
  return Object.keys(store.keys)
}
