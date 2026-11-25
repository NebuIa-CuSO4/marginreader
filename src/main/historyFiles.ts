import fs from 'node:fs/promises'
import path from 'node:path'
import type { HistoryFilter, HistoryPreview } from '../shared/api'
import type { ChatRequestLog } from '../shared/types'
import { saveRequestRecord } from './requestLog'

interface RequestFiles {
  id: string
  log: string | null
  images: string[]
}

const archiveName = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-([a-f0-9]{8})(\.json|-\d+\.(?:jpe?g|png|webp|gif))$/i

async function scan(logDir: string, before: number): Promise<RequestFiles[]> {
  const files = await fs.readdir(logDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const groups = new Map<string, RequestFiles>()
  for (const file of files) {
    if (!file.isFile()) continue
    const match = archiveName.exec(file.name)
    if (!match) continue
    const [, day, hour, minute, second, ms, random, extension] = match
    const timestamp = Date.parse(`${day}T${hour}:${minute}:${second}.${ms}Z`)
    if (!Number.isFinite(timestamp) || timestamp >= before) continue
    const id = `${day}T${hour}-${minute}-${second}-${ms}Z-${random}`
    const group = groups.get(id) ?? { id, log: null, images: [] }
    if (extension.toLowerCase() === '.json') group.log = file.name
    else group.images.push(file.name)
    groups.set(id, group)
  }
  return [...groups.values()]
}

export async function cleanRequestFiles(
  logDir: string, filter: HistoryFilter, remove = false
): Promise<Omit<HistoryPreview, 'messages'>> {
  const result = { logs: 0, images: 0, fileBytes: 0 }
  if (!filter.logs && !filter.images) return result

  for (const group of await scan(logDir, filter.before)) {
    const names = filter.logs && group.log ? [...group.images, group.log] : group.images
    for (const name of names) {
      const file = path.join(logDir, name)
      try {
        const stat = await fs.stat(file)
        if (remove) await fs.unlink(file)
        result.fileBytes += stat.size
        if (name === group.log) result.logs++
        else result.images++
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    if (remove && !filter.logs && group.log && group.images.length) {
      const json = await fs.readFile(path.join(logDir, group.log), 'utf8').catch(() => null)
      let record: ChatRequestLog | null = null
      if (json) {
        try { record = JSON.parse(json) as ChatRequestLog } catch { /* leave unreadable logs alone */ }
      }
      if (record?.requestId === group.id) await saveRequestRecord(logDir, { ...record, images: [] })
    }
  }
  return result
}
