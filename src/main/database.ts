import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type {
  ApiConversation,
  ApiProvider,
  ApiProviderKind,
  ApiUsage,
  SearchStatus,
  ChatMessage,
  Folder,
  FolderKind,
  MessageStatus,
  Note,
  NoteTypeDefinition,
  Project,
  ProjectKind,
  Settings,
  TodoItem,
  Vocab
} from '../shared/types'

const DEFAULT_SETTINGS: Settings = {
  dockSide: 'right',
  theme: 'light',
  pinned: false,
  autoHide: true,
  ocrLanguage: 'auto',
  toggleShortcut: 'CommandOrControl+Shift+Space',
  screenshotShortcut: 'CommandOrControl+Shift+S',
  selectionShortcut: 'CommandOrControl+Shift+E',
  autoSendSelection: true,
  autoScreenContext: true,
  archiveRequestImages: false,
  launchAtLogin: false,
  activeProjectId: 'english-reading',
  onboardingDone: false,
  defaultProviderId: 'deepseek',
  defaultModel: 'deepseek-chat'
}

function now(): number {
  return Date.now()
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export class AppDatabase {
  private db: DatabaseSync

  constructor(filePath: string) {
    this.db = new DatabaseSync(filePath)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversation_bindings (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        provider TEXT NOT NULL DEFAULT 'deepseek-web',
        external_id TEXT,
        url TEXT,
        status TEXT NOT NULL DEFAULT 'unbound',
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS api_providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'openai-compatible',
        base_url TEXT NOT NULL,
        models TEXT NOT NULL DEFAULT '[]',
        default_model TEXT NOT NULL DEFAULT '',
        supports_vision INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'api',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        conversation_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        reasoning TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'complete',
        created_at INTEGER NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        usage TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id, created_at);

      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        folder_id TEXT,
        note_type_id TEXT,
        notebook TEXT NOT NULL DEFAULT '文献笔记',
        type TEXT NOT NULL DEFAULT 'note',
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notes_project ON notes(project_id, updated_at);

      CREATE TABLE IF NOT EXISTS vocab (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        folder_id TEXT,
        word TEXT NOT NULL,
        phonetic TEXT NOT NULL DEFAULT '',
        meaning TEXT NOT NULL DEFAULT '',
        example TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        review_count INTEGER NOT NULL DEFAULT 0,
        last_reviewed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_vocab_project ON vocab(project_id, updated_at);

      CREATE TABLE IF NOT EXISTS folders (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        parent_id TEXT,
        name TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_folders_kind ON folders(kind, parent_id, sort_order);

      CREATE TABLE IF NOT EXISTS note_types (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)

    const messageColumns = this.db.prepare('PRAGMA table_info(messages)').all() as unknown as Array<{
      name: string
    }>
    if (!messageColumns.some((column) => column.name === 'reasoning')) {
      this.db.exec("ALTER TABLE messages ADD COLUMN reasoning TEXT NOT NULL DEFAULT ''")
    }
    if (!messageColumns.some((column) => column.name === 'conversation_id')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN conversation_id TEXT')
    }
    if (!messageColumns.some((column) => column.name === 'model')) {
      this.db.exec("ALTER TABLE messages ADD COLUMN model TEXT NOT NULL DEFAULT ''")
    }
    if (!messageColumns.some((column) => column.name === 'search_status')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN search_status TEXT')
    }
    if (!messageColumns.some((column) => column.name === 'usage')) {
      this.db.exec("ALTER TABLE messages ADD COLUMN usage TEXT NOT NULL DEFAULT ''")
    }
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at)'
    )

    const noteColumns = this.db.prepare('PRAGMA table_info(notes)').all() as unknown as Array<{
      name: string
    }>
    if (!noteColumns.some((column) => column.name === 'folder_id')) {
      this.db.exec('ALTER TABLE notes ADD COLUMN folder_id TEXT')
    }
    if (!noteColumns.some((column) => column.name === 'note_type_id')) {
      this.db.exec('ALTER TABLE notes ADD COLUMN note_type_id TEXT')
    }
    const vocabColumns = this.db.prepare('PRAGMA table_info(vocab)').all() as unknown as Array<{
      name: string
    }>
    if (!vocabColumns.some((column) => column.name === 'folder_id')) {
      this.db.exec('ALTER TABLE vocab ADD COLUMN folder_id TEXT')
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(folder_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_vocab_folder ON vocab(folder_id, updated_at);
    `)

    const providerCount = Number(
      (this.db.prepare('SELECT COUNT(*) AS count FROM api_providers').get() as { count: number })
        .count ?? 0
    )
    if (providerCount === 0) {
      this.db
        .prepare(
          `INSERT INTO api_providers
             (id, name, kind, base_url, models, default_model, supports_vision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
        )
        .run(
          'deepseek',
          'DeepSeek',
          'deepseek',
          'https://api.deepseek.com',
          JSON.stringify(['deepseek-chat', 'deepseek-reasoner']),
          'deepseek-chat',
          now(),
          now()
        )
    }

    const migrationSettings = this.getSettings()
    const projects = this.listProjects()
    const conversationInsert = this.db.prepare(
      `INSERT INTO conversations
         (id, project_id, provider_id, model, title, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const project of projects) {
      const existing = this.db
        .prepare('SELECT id FROM conversations WHERE project_id = ?')
        .get(project.id) as { id: string } | undefined
      if (existing) continue
      const legacy = this.db
        .prepare('SELECT project_id FROM conversation_bindings WHERE project_id = ?')
        .get(project.id)
      const provider = this.getApiProvider(migrationSettings.defaultProviderId)
      const providerId = provider?.id ?? 'deepseek'
      const model =
        migrationSettings.defaultModel ||
        provider?.defaultModel ||
        provider?.models[0] ||
        'deepseek-chat'
      conversationInsert.run(
        randomUUID(),
        project.id,
        providerId,
        model,
        project.title,
        legacy ? 'migrated-web' : 'api',
        project.createdAt,
        now()
      )
    }
    this.db
      .prepare(
        `UPDATE messages
         SET conversation_id = (
           SELECT conversations.id FROM conversations WHERE conversations.project_id = messages.project_id
         )
         WHERE conversation_id IS NULL`
      )
      .run()

    const typeCount = Number(
      (this.db.prepare('SELECT COUNT(*) AS count FROM note_types').get() as { count: number }).count ?? 0
    )
    if (typeCount === 0) {
      const defaults = [
        ['文献笔记', '#2f6f6a'],
        ['概念卡片', '#8a6d3b'],
        ['句子摘录', '#6b5b95'],
        ['英语阅读', '#3b6ea5'],
        ['灵感', '#a45b5b']
      ]
      const insert = this.db.prepare(
        'INSERT INTO note_types (id, name, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      defaults.forEach(([name, color], index) => {
        insert.run(randomUUID(), name, color, index, now(), now())
      })
    }
    const noteTypes = this.db.prepare('SELECT id, name FROM note_types').all() as unknown as Array<{
      id: string
      name: string
    }>
    const typeByName = new Map(noteTypes.map((item) => [item.name, item.id]))
    const notebooks = this.db
      .prepare("SELECT DISTINCT notebook FROM notes WHERE TRIM(notebook) <> ''")
      .all() as unknown as Array<{ notebook: string }>
    for (const row of notebooks) {
      if (!typeByName.has(row.notebook)) {
        const id = randomUUID()
        const nextSort = noteTypes.length
        this.db
          .prepare(
            'INSERT INTO note_types (id, name, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
          )
          .run(id, row.notebook, '#6b6b6b', nextSort, now(), now())
        typeByName.set(row.notebook, id)
        noteTypes.push({ id, name: row.notebook })
      }
    }
    for (const [name, id] of typeByName) {
      this.db
        .prepare('UPDATE notes SET note_type_id = ? WHERE note_type_id IS NULL AND notebook = ?')
        .run(id, name)
    }
    const fallbackType = noteTypes[0]?.id ?? null
    if (fallbackType) {
      this.db
        .prepare('UPDATE notes SET note_type_id = ? WHERE note_type_id IS NULL')
        .run(fallbackType)
    }

    const english = this.db.prepare('SELECT id FROM projects WHERE id = ?').get('english-reading')
    if (!english) {
      this.db
        .prepare('INSERT INTO projects (id, kind, title, author, created_at) VALUES (?, ?, ?, ?, ?)')
        .run('english-reading', 'english', '英语阅读', '', now())
    }
    const englishProject = this.getProject('english-reading')
    if (englishProject) this.ensureConversation(englishProject)
    this.db
      .prepare(
        `UPDATE messages
         SET conversation_id = (
           SELECT conversations.id FROM conversations WHERE conversations.project_id = messages.project_id
         )
         WHERE conversation_id IS NULL`
      )
      .run()

    const active = this.db.prepare('SELECT value FROM settings WHERE key = ?').get('app')
    if (!active) {
      this.setSettings(DEFAULT_SETTINGS)
    }
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      // ignore
    }
  }

  listTodos(): TodoItem[] {
    return this.db.prepare(
      'SELECT id, title, completed, created_at FROM todos ORDER BY completed ASC, created_at DESC, id DESC'
    ).all().map((row) => ({
      id: String(row.id), title: String(row.title),
      completed: Boolean(row.completed), createdAt: Number(row.created_at)
    }))
  }

  addTodo(value: string): TodoItem {
    const title = value.trim()
    if (!title || title.length > 200) throw new Error('待办标题需要 1–200 个字符。')
    const item = { id: randomUUID(), title, completed: false, createdAt: now() }
    this.db.prepare('INSERT INTO todos (id, title, completed, created_at) VALUES (?, ?, 0, ?)')
      .run(item.id, item.title, item.createdAt)
    return item
  }

  updateTodo(id: string, patch: { title?: string; completed?: boolean }): TodoItem {
    const row = this.db.prepare('SELECT title, completed, created_at FROM todos WHERE id = ?').get(id)
    if (!row) throw new Error('待办已不存在。')
    const title = patch.title?.trim() ?? String(row.title)
    if (!title || title.length > 200) throw new Error('待办标题需要 1–200 个字符。')
    const completed = patch.completed ?? Boolean(row.completed)
    this.db.prepare('UPDATE todos SET title = ?, completed = ? WHERE id = ?').run(title, Number(completed), id)
    return { id, title, completed, createdAt: Number(row.created_at) }
  }

  removeTodo(id: string): void {
    this.db.prepare('DELETE FROM todos WHERE id = ?').run(id)
  }

  listProjects(): Project[] {
    const rows = this.db
      .prepare('SELECT * FROM projects ORDER BY kind = ? DESC, created_at ASC')
      .all('english') as unknown as Array<Record<string, unknown>>
    return rows.map((row) => this.mapProject(row))
  }

  getProject(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? this.mapProject(row) : null
  }

  private mapProject(row: Record<string, unknown>): Project {
    return {
      id: String(row.id),
      kind: String(row.kind) as ProjectKind,
      title: String(row.title),
      author: String(row.author ?? ''),
      createdAt: Number(row.created_at)
    }
  }

  createProject(kind: ProjectKind, title: string, author = ''): Project {
    const project: Project = {
      id: randomUUID(),
      kind,
      title: title.trim() || (kind === 'english' ? '英语阅读' : '未命名文献'),
      author: author.trim(),
      createdAt: now()
    }
    this.db
      .prepare('INSERT INTO projects (id, kind, title, author, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(project.id, project.kind, project.title, project.author, project.createdAt)
    this.ensureConversation(project)
    return project
  }

  deleteProject(id: string): void {
    if (id === 'english-reading') return
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  }

  listApiProviders(): ApiProvider[] {
    const rows = this.db
      .prepare('SELECT * FROM api_providers ORDER BY created_at ASC')
      .all() as unknown as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      kind: String(row.kind) as ApiProviderKind,
      baseUrl: String(row.base_url),
      models: parseJson<string[]>(String(row.models ?? '[]'), []),
      defaultModel: String(row.default_model ?? ''),
      supportsVision: Number(row.supports_vision) === 1,
      hasKey: false,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    }))
  }

  getApiProvider(id: string): ApiProvider | null {
    return this.listApiProviders().find((provider) => provider.id === id) ?? null
  }

  saveApiProvider(input: Partial<ApiProvider> & { id: string; name: string; baseUrl: string }): ApiProvider {
    const existing = this.getApiProvider(input.id)
    const models = input.models ?? existing?.models ?? []
    const provider: ApiProvider = {
      id: input.id,
      name: input.name.trim() || 'API',
      kind: input.kind ?? existing?.kind ?? 'openai-compatible',
      baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
      models,
      defaultModel:
        input.defaultModel?.trim() || existing?.defaultModel || models[0] || '',
      supportsVision: input.supportsVision ?? existing?.supportsVision ?? false,
      hasKey: false,
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now()
    }
    this.db
      .prepare(
        `INSERT INTO api_providers
           (id, name, kind, base_url, models, default_model, supports_vision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           kind = excluded.kind,
           base_url = excluded.base_url,
           models = excluded.models,
           default_model = excluded.default_model,
           supports_vision = excluded.supports_vision,
           updated_at = excluded.updated_at`
      )
      .run(
        provider.id,
        provider.name,
        provider.kind,
        provider.baseUrl,
        JSON.stringify(provider.models),
        provider.defaultModel,
        provider.supportsVision ? 1 : 0,
        provider.createdAt,
        provider.updatedAt
      )
    return provider
  }

  deleteApiProvider(id: string): void {
    this.db.prepare('DELETE FROM api_providers WHERE id = ?').run(id)
  }

  ensureConversation(project: Project, source: ApiConversation['source'] = 'api'): ApiConversation {
    const existing = this.getConversation(project.id)
    if (existing) return existing
    const settings = this.getSettings()
    const provider =
      this.getApiProvider(settings.defaultProviderId) ?? this.listApiProviders()[0] ?? null
    const providerId = provider?.id ?? 'deepseek'
    const model =
      settings.defaultModel || provider?.defaultModel || provider?.models[0] || 'deepseek-chat'
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO conversations
           (id, project_id, provider_id, model, title, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, project.id, providerId, model, project.title, source, project.createdAt, now())
    return {
      id,
      projectId: project.id,
      providerId,
      model,
      title: project.title,
      source,
      createdAt: project.createdAt,
      updatedAt: now()
    }
  }

  getConversation(projectId: string): ApiConversation | null {
    const row = this.db
      .prepare('SELECT * FROM conversations WHERE project_id = ?')
      .get(projectId) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      providerId: String(row.provider_id),
      model: String(row.model ?? ''),
      title: String(row.title ?? ''),
      source: String(row.source) as ApiConversation['source'],
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    }
  }

  updateConversation(
    projectId: string,
    patch: Partial<Pick<ApiConversation, 'providerId' | 'model' | 'title'>>
  ): ApiConversation | null {
    const existing = this.getConversation(projectId)
    if (!existing) return null
    this.db
      .prepare(
        `UPDATE conversations
         SET provider_id = ?, model = ?, title = ?, updated_at = ?
         WHERE project_id = ?`
      )
      .run(
        patch.providerId ?? existing.providerId,
        patch.model ?? existing.model,
        patch.title ?? existing.title,
        now(),
        projectId
      )
    return this.getConversation(projectId)
  }

  listContextMessages(projectId: string): ChatMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE project_id = ? AND status = 'complete'
           AND role IN ('user', 'assistant')
           AND TRIM(content) <> ''
         ORDER BY created_at ASC, id ASC`
      )
      .all(projectId) as unknown as Array<Record<string, unknown>>
    const messages = rows.map((row) => this.mapMessage(row))
    const context: ChatMessage[] = []
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]
      if (message.role !== 'user') continue
      const answer = messages[index + 1]
      if (!answer || answer.role !== 'assistant') continue
      context.push(message, answer)
      index += 1
    }
    return context
  }

  private mapMessage(row: Record<string, unknown>): ChatMessage {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      conversationId: row.conversation_id ? String(row.conversation_id) : undefined,
      role: String(row.role) as ChatMessage['role'],
      content: String(row.content ?? ''),
      reasoning: String(row.reasoning ?? ''),
      status: String(row.status) as ChatMessage['status'],
      createdAt: Number(row.created_at),
      model: row.model ? String(row.model) : undefined,
      searchStatus: (row.search_status || undefined) as SearchStatus | undefined,
      usage: parseJson<ApiUsage | undefined>(String(row.usage ?? ''), undefined)
    }
  }

  listMessages(projectId: string): ChatMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE project_id = ? ORDER BY created_at ASC')
      .all(projectId) as unknown as Array<Record<string, unknown>>
    return rows.map((row) => this.mapMessage(row))
  }

  listMessagePage(
    projectId: string,
    limit = 50,
    before?: { createdAt: number; id: string }
  ): { messages: ChatMessage[]; hasMore: boolean; oldest: { createdAt: number; id: string } | null } {
    const pageSize = Math.min(200, Math.max(1, Math.floor(limit)))
    const fetchSize = pageSize + 1
    const rows = (
      before
        ? (this.db
            .prepare(
              `SELECT * FROM messages
               WHERE project_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
               ORDER BY created_at DESC, id DESC
               LIMIT ?`
            )
            .all(
              projectId,
              before.createdAt,
              before.createdAt,
              before.id,
              fetchSize
            ) as unknown as Array<Record<string, unknown>>)
        : (this.db
            .prepare(
              `SELECT * FROM messages
               WHERE project_id = ?
               ORDER BY created_at DESC, id DESC
               LIMIT ?`
            )
            .all(projectId, fetchSize) as unknown as Array<Record<string, unknown>>)
    ).reverse()
    const hasMore = rows.length > pageSize
    const pageRows = hasMore ? rows.slice(1) : rows
    const messages = pageRows.map((row) => this.mapMessage(row))
    return {
      messages,
      hasMore,
      oldest: messages[0]
        ? { createdAt: messages[0].createdAt, id: messages[0].id }
        : null
    }
  }

  addMessage(message: ChatMessage): void {
    this.db
      .prepare(
        `INSERT INTO messages
           (id, project_id, conversation_id, role, content, reasoning, status, created_at, model, usage)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        message.id,
        message.projectId,
        message.conversationId ?? this.getConversation(message.projectId)?.id ?? null,
        message.role,
        message.content,
        message.reasoning ?? '',
        message.status,
        message.createdAt,
        message.model ?? '',
        message.usage ? JSON.stringify(message.usage) : ''
      )
  }

  updateMessage(
    id: string,
    content: string,
    status: MessageStatus,
    reasoning = '',
    usage?: ApiUsage,
    model?: string,
    searchStatus?: SearchStatus
  ): void {
    this.db
      .prepare(
        'UPDATE messages SET content = ?, reasoning = ?, status = ?, usage = ?, model = ?, search_status = ? WHERE id = ?'
      )
      .run(
        content,
        reasoning,
        status,
        usage ? JSON.stringify(usage) : '',
        model ?? '',
        searchStatus ?? null,
        id
      )
  }

  deleteMessage(id: string): void {
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(id)
  }

  historyCutoff(projectId: string, before: number): number {
    const firstKept = this.db.prepare(
      'SELECT role FROM messages WHERE project_id = ? AND created_at >= ? ORDER BY created_at, id LIMIT 1'
    ).get(projectId, before)
    if (firstKept?.role !== 'assistant') return before
    const lastQuestion = this.db.prepare(
      "SELECT MAX(created_at) AS created_at FROM messages WHERE project_id = ? AND role = 'user' AND created_at < ?"
    ).get(projectId, before)
    return typeof lastQuestion?.created_at === 'number' ? lastQuestion.created_at : before
  }

  countMessagesBefore(projectId: string, before: number): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE project_id = ? AND created_at < ?')
      .get(projectId, before)
    return Number(row?.count ?? 0)
  }

  deleteMessagesBefore(projectId: string, before: number): number {
    const result = this.db.prepare('DELETE FROM messages WHERE project_id = ? AND created_at < ?').run(projectId, before)
    return Number(result.changes)
  }

  clearMessages(projectId: string): void {
    this.db.prepare('DELETE FROM messages WHERE project_id = ?').run(projectId)
  }

  markStreamingInterrupted(): void {
    this.db
      .prepare("UPDATE messages SET status = 'interrupted' WHERE status IN ('sending', 'streaming')")
      .run()
  }

  listNotes(projectId = '', query = ''): Note[] {
    const q = query.trim()
    let rows: Record<string, unknown>[]
    if (q && projectId) {
      rows = this.db
        .prepare(
          `SELECT * FROM notes WHERE project_id = ? AND
           (title LIKE ? OR content LIKE ? OR tags LIKE ? OR notebook LIKE ?)
           ORDER BY updated_at DESC`
        )
        .all(projectId, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`) as unknown as Record<string, unknown>[]
    } else if (q) {
      rows = this.db
        .prepare(
          `SELECT * FROM notes WHERE
           (title LIKE ? OR content LIKE ? OR tags LIKE ? OR notebook LIKE ?)
           ORDER BY updated_at DESC`
        )
        .all(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`) as unknown as Record<string, unknown>[]
    } else if (projectId) {
      rows = this.db
        .prepare('SELECT * FROM notes WHERE project_id = ? ORDER BY updated_at DESC')
        .all(projectId) as unknown as Record<string, unknown>[]
    } else {
      rows = this.db
        .prepare('SELECT * FROM notes ORDER BY updated_at DESC')
        .all() as unknown as Record<string, unknown>[]
    }
    return rows.map((row) => ({
      id: String(row.id),
      projectId: String(row.project_id),
      folderId: row.folder_id ? String(row.folder_id) : null,
      noteTypeId: row.note_type_id ? String(row.note_type_id) : null,
      notebook: String(row.notebook),
      type: String(row.type) as Note['type'],
      title: String(row.title),
      content: String(row.content),
      tags: parseJson<string[]>(String(row.tags ?? '[]'), []),
      source: String(row.source ?? ''),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    }))
  }

  saveNote(input: Partial<Note> & { projectId: string; title: string }): Note {
    const existing = input.id
      ? (this.db.prepare('SELECT * FROM notes WHERE id = ?').get(input.id) as Record<string, unknown> | undefined)
      : undefined
    const timestamp = now()
    const noteTypeId = input.noteTypeId ?? (existing?.note_type_id as string | null | undefined) ?? null
    const hasFolderId = Object.prototype.hasOwnProperty.call(input, 'folderId')
    const typeRow = noteTypeId
      ? (this.db.prepare('SELECT name FROM note_types WHERE id = ?').get(noteTypeId) as
          | { name: string }
          | undefined)
      : undefined
    const note: Note = {
      id: input.id || randomUUID(),
      projectId: input.projectId,
      folderId: hasFolderId
        ? (input.folderId ?? null)
        : ((existing?.folder_id as string | null | undefined) ?? null),
      noteTypeId,
      notebook: input.notebook?.trim() || typeRow?.name || '文献笔记',
      type: (input.type as Note['type']) || 'note',
      title: input.title.trim() || '未命名笔记',
      content: input.content ?? '',
      tags: input.tags ?? [],
      source: input.source ?? '',
      createdAt: existing ? Number(existing.created_at) : timestamp,
      updatedAt: timestamp
    }
    if (existing) {
      this.db
        .prepare(
          `UPDATE notes SET folder_id = ?, note_type_id = ?, notebook = ?, type = ?, title = ?, content = ?, tags = ?, source = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          note.folderId,
          note.noteTypeId,
          note.notebook,
          note.type,
          note.title,
          note.content,
          JSON.stringify(note.tags),
          note.source,
          note.updatedAt,
          note.id
        )
    } else {
      this.db
        .prepare(
          `INSERT INTO notes (id, project_id, folder_id, note_type_id, notebook, type, title, content, tags, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          note.id,
          note.projectId,
          note.folderId,
          note.noteTypeId,
          note.notebook,
          note.type,
          note.title,
          note.content,
          JSON.stringify(note.tags),
          note.source,
          note.createdAt,
          note.updatedAt
        )
    }
    return note
  }

  deleteNote(id: string): void {
    this.db.prepare('DELETE FROM notes WHERE id = ?').run(id)
  }

  listVocab(projectId = '', query = ''): Vocab[] {
    const q = query.trim()
    let rows: Record<string, unknown>[]
    if (q && projectId) {
      rows = this.db
        .prepare(
          `SELECT * FROM vocab WHERE project_id = ? AND
           (word LIKE ? OR meaning LIKE ? OR example LIKE ?)
           ORDER BY updated_at DESC`
        )
        .all(projectId, `%${q}%`, `%${q}%`, `%${q}%`) as unknown as Record<string, unknown>[]
    } else if (q) {
      rows = this.db
        .prepare(
          `SELECT * FROM vocab WHERE
           (word LIKE ? OR meaning LIKE ? OR example LIKE ?)
           ORDER BY updated_at DESC`
        )
        .all(`%${q}%`, `%${q}%`, `%${q}%`) as unknown as Record<string, unknown>[]
    } else if (projectId) {
      rows = this.db
        .prepare('SELECT * FROM vocab WHERE project_id = ? ORDER BY updated_at DESC')
        .all(projectId) as unknown as Record<string, unknown>[]
    } else {
      rows = this.db
        .prepare('SELECT * FROM vocab ORDER BY updated_at DESC')
        .all() as unknown as Record<string, unknown>[]
    }
    return rows.map((row) => ({
      id: String(row.id),
      projectId: String(row.project_id),
      folderId: row.folder_id ? String(row.folder_id) : null,
      word: String(row.word),
      phonetic: String(row.phonetic ?? ''),
      meaning: String(row.meaning ?? ''),
      example: String(row.example ?? ''),
      source: String(row.source ?? ''),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      reviewCount: Number(row.review_count ?? 0),
      lastReviewedAt: row.last_reviewed_at === null ? null : Number(row.last_reviewed_at)
    }))
  }

  saveVocab(input: Partial<Vocab> & { projectId: string; word: string }): Vocab {
    const existing = input.id
      ? (this.db.prepare('SELECT * FROM vocab WHERE id = ?').get(input.id) as Record<string, unknown> | undefined)
      : undefined
    const timestamp = now()
    const hasFolderId = Object.prototype.hasOwnProperty.call(input, 'folderId')
    const item: Vocab = {
      id: input.id || randomUUID(),
      projectId: input.projectId,
      folderId: hasFolderId
        ? (input.folderId ?? null)
        : ((existing?.folder_id as string | null | undefined) ?? null),
      word: input.word.trim(),
      phonetic: input.phonetic ?? '',
      meaning: input.meaning ?? '',
      example: input.example ?? '',
      source: input.source ?? '',
      createdAt: existing ? Number(existing.created_at) : timestamp,
      updatedAt: timestamp,
      reviewCount: existing ? Number(existing.review_count ?? 0) : 0,
      lastReviewedAt: existing && existing.last_reviewed_at !== null ? Number(existing.last_reviewed_at) : null
    }
    if (existing) {
      this.db
        .prepare(
          `UPDATE vocab SET folder_id = ?, word = ?, phonetic = ?, meaning = ?, example = ?, source = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          item.folderId,
          item.word,
          item.phonetic,
          item.meaning,
          item.example,
          item.source,
          item.updatedAt,
          item.id
        )
    } else {
      this.db
        .prepare(
          `INSERT INTO vocab (id, project_id, folder_id, word, phonetic, meaning, example, source, created_at, updated_at, review_count, last_reviewed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`
        )
        .run(
          item.id,
          item.projectId,
          item.folderId,
          item.word,
          item.phonetic,
          item.meaning,
          item.example,
          item.source,
          item.createdAt,
          item.updatedAt
        )
    }
    return item
  }

  reviewVocab(id: string): void {
    this.db
      .prepare('UPDATE vocab SET review_count = review_count + 1, last_reviewed_at = ?, updated_at = ? WHERE id = ?')
      .run(now(), now(), id)
  }

  deleteVocab(id: string): void {
    this.db.prepare('DELETE FROM vocab WHERE id = ?').run(id)
  }

  listFolders(kind?: FolderKind): Folder[] {
    const rows = (kind
      ? this.db.prepare('SELECT * FROM folders WHERE kind = ? ORDER BY sort_order, name').all(kind)
      : this.db.prepare('SELECT * FROM folders ORDER BY kind, sort_order, name').all()) as unknown as Array<
      Record<string, unknown>
    >
    return rows.map((row) => ({
      id: String(row.id),
      kind: String(row.kind) as FolderKind,
      parentId: row.parent_id ? String(row.parent_id) : null,
      name: String(row.name),
      color: String(row.color ?? ''),
      sortOrder: Number(row.sort_order ?? 0),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    }))
  }

  createFolder(input: {
    kind: FolderKind
    parentId?: string | null
    name: string
    color?: string
  }): Folder {
    const name = input.name.trim()
    if (!name) throw new Error('文件夹名称不能为空')
    this.assertFolderParent(input.kind, input.parentId ?? null)
    if (this.folderNameExists(input.kind, input.parentId ?? null, name)) {
      throw new Error('同一层级已有同名文件夹')
    }
    const siblings = this.listFolders(input.kind).filter(
      (folder) => folder.parentId === (input.parentId ?? null)
    )
    const folder: Folder = {
      id: randomUUID(),
      kind: input.kind,
      parentId: input.parentId ?? null,
      name,
      color: input.color ?? '',
      sortOrder: siblings.length,
      createdAt: now(),
      updatedAt: now()
    }
    this.db
      .prepare(
        'INSERT INTO folders (id, kind, parent_id, name, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        folder.id,
        folder.kind,
        folder.parentId,
        folder.name,
        folder.color,
        folder.sortOrder,
        folder.createdAt,
        folder.updatedAt
      )
    return folder
  }

  renameFolder(id: string, name: string): void {
    const folder = this.listFolders().find((item) => item.id === id)
    if (!folder) throw new Error('文件夹不存在')
    const nextName = name.trim()
    if (!nextName) throw new Error('文件夹名称不能为空')
    if (this.folderNameExists(folder.kind, folder.parentId, nextName, id)) {
      throw new Error('同一层级已有同名文件夹')
    }
    this.db
      .prepare('UPDATE folders SET name = ?, updated_at = ? WHERE id = ?')
      .run(nextName, now(), id)
  }

  moveFolder(id: string, parentId: string | null): void {
    const folder = this.listFolders().find((item) => item.id === id)
    if (!folder) throw new Error('文件夹不存在')
    if (parentId === id) throw new Error('不能移动到自身')
    this.assertFolderParent(folder.kind, parentId)
    this.assertNoFolderCycle(id, parentId)
    if (this.folderNameExists(folder.kind, parentId, folder.name, id)) {
      throw new Error('目标层级已有同名文件夹')
    }
    this.db
      .prepare('UPDATE folders SET parent_id = ?, updated_at = ? WHERE id = ?')
      .run(parentId, now(), id)
  }

  deleteFolder(id: string): { notes: number; vocab: number; folders: number } {
    const all = this.listFolders()
    const folder = all.find((item) => item.id === id)
    if (!folder) return { notes: 0, vocab: 0, folders: 0 }
    const descendants = new Set<string>([id])
    let changed = true
    while (changed) {
      changed = false
      for (const item of all) {
        if (item.parentId && descendants.has(item.parentId) && !descendants.has(item.id)) {
          descendants.add(item.id)
          changed = true
        }
      }
    }
    const ids = Array.from(descendants)
    const placeholders = ids.map(() => '?').join(',')
    const notes = Number(
      (
        this.db
          .prepare(`SELECT COUNT(*) AS count FROM notes WHERE folder_id IN (${placeholders})`)
          .get(...ids) as { count: number }
      ).count ?? 0
    )
    const vocab = Number(
      (
        this.db
          .prepare(`SELECT COUNT(*) AS count FROM vocab WHERE folder_id IN (${placeholders})`)
          .get(...ids) as { count: number }
      ).count ?? 0
    )
    const target = folder.parentId
    this.db.prepare(`UPDATE notes SET folder_id = ? WHERE folder_id IN (${placeholders})`).run(target, ...ids)
    this.db.prepare(`UPDATE vocab SET folder_id = ? WHERE folder_id IN (${placeholders})`).run(target, ...ids)
    this.db.prepare(`DELETE FROM folders WHERE id IN (${placeholders})`).run(...ids)
    return { notes, vocab, folders: ids.length }
  }

  listNoteTypes(): NoteTypeDefinition[] {
    const rows = this.db
      .prepare('SELECT * FROM note_types ORDER BY sort_order, name')
      .all() as unknown as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      color: String(row.color ?? ''),
      sortOrder: Number(row.sort_order ?? 0),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    }))
  }

  saveNoteType(input: {
    id?: string
    name: string
    color?: string
  }): NoteTypeDefinition {
    const name = input.name.trim()
    if (!name) throw new Error('类型名称不能为空')
    const existing = input.id
      ? (this.db.prepare('SELECT * FROM note_types WHERE id = ?').get(input.id) as
          | Record<string, unknown>
          | undefined)
      : undefined
    const duplicate = this.db
      .prepare('SELECT id FROM note_types WHERE LOWER(name) = LOWER(?) AND id <> ?')
      .get(name, input.id ?? '')
    if (duplicate) throw new Error('已有同名类型')
    const timestamp = now()
    const types = this.listNoteTypes()
    const item: NoteTypeDefinition = {
      id: input.id || randomUUID(),
      name,
      color: input.color ?? (existing?.color as string | undefined) ?? '',
      sortOrder: existing ? Number(existing.sort_order) : types.length,
      createdAt: existing ? Number(existing.created_at) : timestamp,
      updatedAt: timestamp
    }
    if (existing) {
      this.db
        .prepare('UPDATE note_types SET name = ?, color = ?, updated_at = ? WHERE id = ?')
        .run(item.name, item.color, item.updatedAt, item.id)
      this.db.prepare('UPDATE notes SET notebook = ? WHERE note_type_id = ?').run(item.name, item.id)
    } else {
      this.db
        .prepare(
          'INSERT INTO note_types (id, name, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(item.id, item.name, item.color, item.sortOrder, item.createdAt, item.updatedAt)
    }
    return item
  }

  deleteNoteType(id: string): void {
    this.db
      .prepare("UPDATE notes SET note_type_id = NULL, notebook = '未分类' WHERE note_type_id = ?")
      .run(id)
    this.db.prepare('DELETE FROM note_types WHERE id = ?').run(id)
  }

  getProjectUsage(projectId: string): { notes: number; vocab: number; messages: number } {
    const count = (table: string): number =>
      Number(
        (
          this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ?`).get(projectId) as {
            count: number
          }
        ).count ?? 0
      )
    return {
      notes: count('notes'),
      vocab: count('vocab'),
      messages: count('messages')
    }
  }

  private assertFolderParent(kind: FolderKind, parentId: string | null): void {
    if (!parentId) return
    const parent = this.db.prepare('SELECT kind FROM folders WHERE id = ?').get(parentId) as
      | { kind: string }
      | undefined
    if (!parent || parent.kind !== kind) throw new Error('上级文件夹无效')
  }

  private assertNoFolderCycle(id: string, parentId: string | null): void {
    if (!parentId) return
    const all = this.listFolders()
    const byId = new Map(all.map((folder) => [folder.id, folder]))
    let current: string | null = parentId
    while (current) {
      if (current === id) throw new Error('不能把文件夹移动到自己的子文件夹')
      current = byId.get(current)?.parentId ?? null
    }
  }

  private folderNameExists(
    kind: FolderKind,
    parentId: string | null,
    name: string,
    excludeId = ''
  ): boolean {
    return this.listFolders(kind).some(
      (folder) =>
        folder.id !== excludeId &&
        folder.parentId === parentId &&
        folder.name.toLocaleLowerCase() === name.toLocaleLowerCase()
    )
  }

  getSettings(): Settings {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get('app') as
      | { value: string }
      | undefined
    const stored = parseJson<Partial<Settings>>(row?.value, {})
    return { ...DEFAULT_SETTINGS, ...stored }
  }

  setSettings(settings: Settings): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('app', JSON.stringify(settings))
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const next = { ...this.getSettings(), ...patch }
    this.setSettings(next)
    return next
  }

  exportAll(): Record<string, unknown> {
    return {
      exportedAt: new Date().toISOString(),
      projects: this.listProjects(),
      todos: this.listTodos(),
      apiProviders: this.listApiProviders().map(({ hasKey: _hasKey, ...provider }) => provider),
      conversations: this.listProjects()
        .map((project) => this.getConversation(project.id))
        .filter(Boolean),
      messages: this.listProjects().flatMap((project) => this.listMessages(project.id)),
      notes: this.listProjects().flatMap((project) => this.listNotes(project.id)),
      vocab: this.listProjects().flatMap((project) => this.listVocab(project.id)),
      folders: this.listFolders(),
      noteTypes: this.listNoteTypes(),
      settings: this.getSettings()
    }
  }
}
