import type { Folder } from '../../shared/types'

export type FolderFilter = 'all' | 'uncategorized' | string

export interface FolderNode extends Folder {
  children: FolderNode[]
}

export function buildFolderTree(folders: Folder[]): FolderNode[] {
  const nodes = new Map<string, FolderNode>()
  for (const folder of folders) nodes.set(folder.id, { ...folder, children: [] })
  const roots: FolderNode[] = []
  for (const node of nodes.values()) {
    if (node.parentId && nodes.has(node.parentId)) nodes.get(node.parentId)!.children.push(node)
    else roots.push(node)
  }
  const sort = (list: FolderNode[]): void => {
    list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'zh-CN'))
    for (const item of list) sort(item.children)
  }
  sort(roots)
  return roots
}

export function folderIdsInSubtree(folders: Folder[], folderId: string): string[] {
  const ids = new Set<string>([folderId])
  let changed = true
  while (changed) {
    changed = false
    for (const folder of folders) {
      if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id)
        changed = true
      }
    }
  }
  return Array.from(ids)
}

export function folderPath(folders: Folder[], folderId: string | null): Folder[] {
  if (!folderId) return []
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const path: Folder[] = []
  let current = byId.get(folderId)
  const seen = new Set<string>()
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    path.unshift(current)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return path
}

export function filterByFolder<T extends { folderId: string | null }>(
  items: T[],
  folders: Folder[],
  filter: FolderFilter
): T[] {
  if (filter === 'all') return items
  if (filter === 'uncategorized') return items.filter((item) => !item.folderId)
  const ids = new Set(folderIdsInSubtree(folders, filter))
  return items.filter((item) => item.folderId && ids.has(item.folderId))
}

export function countFolderItems<T extends { folderId: string | null }>(
  items: T[],
  folders: Folder[],
  folderId: string
): number {
  const ids = new Set(folderIdsInSubtree(folders, folderId))
  return items.filter((item) => item.folderId && ids.has(item.folderId)).length
}
