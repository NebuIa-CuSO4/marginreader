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
  } catch {
    return { keys: {} }
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
  const store = await readStore()
  const encrypted = store.keys[providerId]
  if (!encrypted) return null
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch {
    return null
  }
}

export async function saveApiKey(providerId: string, key: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('当前系统无法安全保存 API Key，已拒绝明文存储。')
  }
  const store = await readStore()
  const encrypted = safeStorage.encryptString(key.trim()).toString('base64')
  store.keys[providerId] = encrypted
  await writeStore(store)
}

export async function clearApiKey(providerId: string): Promise<void> {
  const store = await readStore()
  delete store.keys[providerId]
  await writeStore(store)
}

export async function listConfiguredProviders(): Promise<string[]> {
  const store = await readStore()
  return Object.keys(store.keys)
}
