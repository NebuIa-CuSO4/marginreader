const KNOWN_ROUTES = new Set([
  '',
  'sign_in',
  'signin',
  'login',
  'chat',
  'a',
  's',
  'conversation',
  'new',
  'home'
])

export function extractConversationId(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl)
    const path = parsed.pathname
    const patterns = [
      /\/a\/chat\/s\/([A-Za-z0-9_-]+)/,
      /\/chat\/([A-Za-z0-9_-]+)/,
      /\/conversation\/([A-Za-z0-9_-]+)/,
      /\/s\/([A-Za-z0-9_-]+)/
    ]
    for (const pattern of patterns) {
      const match = path.match(pattern)
      if (match?.[1] && !KNOWN_ROUTES.has(match[1])) return match[1]
    }
    const parts = path.split('/').filter(Boolean)
    const last = parts[parts.length - 1] ?? ''
    if (!KNOWN_ROUTES.has(last) && /^[A-Za-z0-9_-]{8,}$/.test(last)) return last
    return null
  } catch {
    return null
  }
}

export function normalizeConversationUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim()
  if (!/^https?:\/\//i.test(trimmed)) {
    const id = trimmed.replace(/^\/+/, '')
    if (/^[A-Za-z0-9_-]{8,}$/.test(id)) return `https://chat.deepseek.com/a/chat/s/${id}`
    return `https://chat.deepseek.com/${id}`
  }
  return trimmed
}
