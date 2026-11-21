import { useEffect, useState } from 'react'
import {
  Download,
  KeyRound,
  Loader2,
  Monitor,
  PanelTop,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2
} from 'lucide-react'
import type { ApiConversation, ApiProvider, ApiStatus, Settings } from '../../../shared/types'
import { Modal } from './Modal'

interface SettingsModalProps {
  settings: Settings
  providers: ApiProvider[]
  status: ApiStatus
  conversation: ApiConversation | null
  onChange: (patch: Partial<Settings>) => Promise<void>
  onRefresh: () => Promise<void>
  onConversationChange: (input: { providerId?: string; model?: string }) => Promise<void>
  onExport: () => Promise<void>
  onClose: () => void
}

export function SettingsModal({
  settings,
  providers,
  status,
  conversation,
  onChange,
  onRefresh,
  onConversationChange,
  onExport,
  onClose
}: SettingsModalProps): React.JSX.Element {
  const [toggleShortcut, setToggleShortcut] = useState(settings.toggleShortcut)
  const [screenshotShortcut, setScreenshotShortcut] = useState(settings.screenshotShortcut)
  const [selectionShortcut, setSelectionShortcut] = useState(settings.selectionShortcut)
  const [saved, setSaved] = useState(false)
  const [selectedId, setSelectedId] = useState(conversation?.providerId ?? providers[0]?.id ?? '')
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [models, setModels] = useState('')
  const [defaultModel, setDefaultModel] = useState('')
  const [supportsVision, setSupportsVision] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  const [dirty, setDirty] = useState(false)
  const [testModel, setTestModel] = useState('')

  const selected = providers.find((provider) => provider.id === selectedId) ?? null
  const selectedModel = conversation?.model ?? defaultModel

  useEffect(() => {
    if (!selected) return
    setName(selected.name)
    setBaseUrl(selected.baseUrl)
    setModels(selected.models.join('\n'))
    setDefaultModel(selected.defaultModel)
    setSupportsVision(selected.supportsVision)
    setTestModel(selected.defaultModel || selected.models[0] || '')
    setApiKey('')
    setDirty(false)
  }, [selected])

  async function run(task: () => Promise<void>): Promise<void> {
    setBusy(true)
    setResult('')
    try {
      await task()
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  function providerPayload(): Partial<ApiProvider> & { id: string; name: string; baseUrl: string } {
    const modelList = models
      .split(/[\n,，]/)
      .map((item) => item.trim())
      .filter(Boolean)
    const fallback = defaultModel.trim()
    if (fallback && !modelList.includes(fallback)) modelList.unshift(fallback)
    return {
      id: selected?.id ?? selectedId,
      name: name.trim() || 'API',
      baseUrl: baseUrl.trim(),
      kind: selected?.kind ?? 'openai-compatible',
      models: modelList,
      defaultModel: fallback || modelList[0] || '',
      supportsVision
    }
  }

  async function saveProvider(): Promise<void> {
    await run(async () => {
      const provider = await window.margin.api.saveProvider(providerPayload())
      await onRefresh()
      setSelectedId(provider.id)
      setDirty(false)
      setResult('API 配置已保存。')
    })
  }

  async function toggleVision(next: boolean): Promise<void> {
    setSupportsVision(next)
    setDirty(true)
    if (!selected || !next) return
    // Persist the capability immediately so closing the dialog cannot lose it.
    setBusy(true)
    setResult('')
    try {
      await window.margin.api.saveProvider({
        ...providerPayload(),
        supportsVision: true
      })
      setDirty(false)
      await onRefresh()
      setResult('已保存：该 API 支持图片输入。')
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function saveKey(): Promise<void> {
    if (!selected || !apiKey.trim()) return
    await run(async () => {
      await window.margin.api.saveKey(selected.id, apiKey)
      setApiKey('')
      await onRefresh()
      setResult('API Key 已加密保存。')
    })
  }

  async function test(): Promise<void> {
    if (!selected) return
    await run(async () => {
      const testResult = await window.margin.api.test(selected.id, {
        model: testModel || undefined,
        probeImages: true
      })
      setResult(testResult.message)
      await onRefresh()
      if (testResult.models?.length) setModels(testResult.models.join('\n'))
    })
  }

  async function detectVision(): Promise<void> {
    if (!selected) return
    await run(async () => {
      const testResult = await window.margin.api.test(selected.id, {
        model: testModel || undefined,
        probeImages: true
      })
      setResult(testResult.message)
      if (testResult.supportsVision !== undefined && testResult.supportsVision !== supportsVision) {
        await window.margin.api.saveProvider({
          ...providerPayload(),
          supportsVision: testResult.supportsVision
        })
        setSupportsVision(testResult.supportsVision)
        setDirty(false)
        await onRefresh()
      }
    })
  }

  async function addProvider(): Promise<void> {
    const id = `api-${Date.now()}`
    await run(async () => {
      const provider = await window.margin.api.saveProvider({
        id,
        name: '自定义 API',
        baseUrl: 'https://api.openai.com/v1',
        kind: 'openai-compatible',
        models: ['gpt-4o-mini'],
        defaultModel: 'gpt-4o-mini',
        supportsVision: false
      })
      await onRefresh()
      setSelectedId(provider.id)
      setResult('已添加 API，请填写地址和密钥。')
    })
  }

  async function removeProvider(): Promise<void> {
    if (!selected || providers.length <= 1) return
    await run(async () => {
      await window.margin.api.deleteProvider(selected.id)
      await onRefresh()
      setSelectedId(providers.find((provider) => provider.id !== selected.id)?.id ?? '')
      setResult('API 配置已删除。')
    })
  }

  async function saveShortcuts(): Promise<void> {
    await onChange({ toggleShortcut, screenshotShortcut, selectionShortcut })
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <Modal title="设置" subtitle="API 服务、模型、侧栏、截图识别和快捷键。" onClose={onClose} wide>
      <div className="settings-sections">
        <section>
          <h4>API 服务</h4>
          <div className="provider-toolbar">
            <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                  {provider.hasKey ? ' · 已配置密钥' : ''}
                </option>
              ))}
            </select>
            <button className="ghost-button" onClick={() => void addProvider()} disabled={busy}>
              <Plus size={14} />
              新增
            </button>
            <button
              className="ghost-button danger-text"
              onClick={() => void removeProvider()}
              disabled={busy || providers.length <= 1}
            >
              <Trash2 size={14} />
              删除
            </button>
          </div>

          <div className="provider-form">
            <label>
              名称
              <input value={name} onChange={(event) => { setName(event.target.value); setDirty(true) }} />
            </label>
            <label>
              Base URL
              <input
                value={baseUrl}
                onChange={(event) => { setBaseUrl(event.target.value); setDirty(true) }}
                placeholder="https://api.deepseek.com"
              />
            </label>
            <label>
              模型列表（每行一个）
              <textarea
                rows={3}
                value={models}
                onChange={(event) => { setModels(event.target.value); setDirty(true) }}
              />
            </label>
            <label>
              默认模型
              <input
                value={defaultModel}
                onChange={(event) => { setDefaultModel(event.target.value); setDirty(true) }}
              />
            </label>
            <label className="check-row provider-check">
              <input
                type="checkbox"
                checked={supportsVision}
                disabled={busy}
                onChange={(event) => void toggleVision(event.target.checked)}
              />
              <span>该 API / 模型支持图片输入（勾选后立即保存）</span>
            </label>
            <div className="vision-probe">
              <label>
                用哪个模型测试
                <input
                  value={testModel}
                  onChange={(event) => setTestModel(event.target.value)}
                  placeholder={selected?.defaultModel || 'deepseek-chat'}
                />
              </label>
              <button className="ghost-button" disabled={busy} onClick={() => void detectVision()}>
                {busy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                测试图片支持
              </button>
            </div>
            <div className="provider-actions">
              <button className="primary-button" disabled={busy} onClick={() => void saveProvider()}>
                {dirty ? '保存 API（有未保存修改）' : '保存 API'}
              </button>
              <button className="ghost-button" disabled={busy} onClick={() => void test()}>
                {busy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                测试连接
              </button>
            </div>
          </div>

          <div className="key-row">
            <div>
              <strong>API Key</strong>
              <span>{selected?.hasKey ? '已加密保存，输入新值可替换。' : '尚未配置。'}</span>
            </div>
            <div className="key-input">
              <input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={selected?.hasKey ? '输入新 Key 以替换' : 'sk-…'}
              />
              <button
                className="ghost-button"
                disabled={busy || !apiKey.trim()}
                onClick={() => void saveKey()}
              >
                <KeyRound size={14} />
                保存
              </button>
            </div>
          </div>
          {selected?.hasKey && (
            <button
              className="ghost-button clear-key"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (!selected) return
                  await window.margin.api.clearKey(selected.id)
                  await onRefresh()
                  setResult('API Key 已清除。')
                })
              }
            >
              清除已保存的密钥
            </button>
          )}

          <div className={`connection-card ${status.phase}`}>
            <span className={`status-dot ${status.phase}`} />
            <div>
              <strong>{status.message}</strong>
              <span>{conversation ? conversation.model : '当前项目尚未选择模型'}</span>
            </div>
          </div>

          {result && <pre className="api-result">{result}</pre>}

          <div className="risk-note">
            <ShieldAlert size={15} />
            <span>
              API Key 只保存在本机，并使用系统加密；不会发送到渲染页面或写入导出文件。API
              使用会计入你的服务商额度。
            </span>
          </div>
        </section>

        <section>
          <h4>当前对话模型</h4>
          <div className="setting-row">
            <div>
              <strong>项目使用的 API</strong>
              <span>切换 API 不会删除历史消息，但不同模型的上下文能力可能不同。</span>
            </div>
            <select
              value={conversation?.providerId ?? selectedId}
              onChange={(event) => void onConversationChange({ providerId: event.target.value })}
            >
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </div>
          <div className="setting-row">
            <div>
              <strong>模型</strong>
              <span>同一个项目始终复用同一条本地对话，不会每条消息新建会话。</span>
            </div>
            <select
              value={conversation?.model || selectedModel}
              onChange={(event) => void onConversationChange({ model: event.target.value })}
            >
              {(providers.find((provider) => provider.id === (conversation?.providerId ?? selectedId))
                ?.models ?? []).map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </div>
        </section>

        <section>
          <h4>侧栏</h4>
          <div className="setting-row">
            <div>
              <strong>停靠位置</strong>
              <span>右侧适合竖版阅读，顶部适合宽屏。</span>
            </div>
            <div className="segmented">
              <button
                className={settings.dockSide === 'right' ? 'active' : ''}
                onClick={() => void onChange({ dockSide: 'right' })}
              >
                <Monitor size={14} />
                右侧
              </button>
              <button
                className={settings.dockSide === 'top' ? 'active' : ''}
                onClick={() => void onChange({ dockSide: 'top' })}
              >
                <PanelTop size={14} />
                顶部
              </button>
            </div>
          </div>
          <div className="setting-row">
            <div>
              <strong>主题</strong>
              <span>阅读时尽量降低对比和视觉噪音。</span>
            </div>
            <div className="segmented">
              {(['light', 'sepia', 'dark'] as const).map((theme) => (
                <button
                  key={theme}
                  className={settings.theme === theme ? 'active' : ''}
                  onClick={() => void onChange({ theme })}
                >
                  {theme === 'light' ? '浅色' : theme === 'sepia' ? '纸色' : '深色'}
                </button>
              ))}
            </div>
          </div>
          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.pinned}
              onChange={(event) => void onChange({ pinned: event.target.checked })}
            />
            <span>固定展开，不自动收起</span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.autoHide}
              onChange={(event) => void onChange({ autoHide: event.target.checked })}
            />
            <span>鼠标离开后自动收起</span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.launchAtLogin}
              onChange={(event) => void onChange({ launchAtLogin: event.target.checked })}
            />
            <span>开机时自动启动 Margin</span>
          </label>
        </section>

        <section>
          <h4>屏幕截图与快捷键</h4>
          <div className="setting-row">
            <div>
              <strong>OCR 语言</strong>
              <span>截图模型不支持图片时，会先做本地 OCR 再发送文字。</span>
            </div>
            <select
              value={settings.ocrLanguage}
              onChange={(event) =>
                void onChange({ ocrLanguage: event.target.value as Settings['ocrLanguage'] })
              }
            >
              <option value="auto">自动</option>
              <option value="en-US">English</option>
              <option value="zh-Hans-CN">简体中文</option>
            </select>
          </div>
          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.autoScreenContext}
              onChange={(event) => void onChange({ autoScreenContext: event.target.checked })}
            />
            <span>每次提问自动截取完整屏幕；模型支持图片时附带原图，否则使用 OCR 文字</span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.autoSendSelection}
              onChange={(event) => void onChange({ autoSendSelection: event.target.checked })}
            />
            <span>划词翻译 / 解释选好后自动发送</span>
          </label>
          <div className="shortcut-grid">
            <label>
              显示 / 收起
              <input
                value={toggleShortcut}
                onChange={(event) => setToggleShortcut(event.target.value)}
              />
            </label>
            <label>
              区域截图
              <input
                value={screenshotShortcut}
                onChange={(event) => setScreenshotShortcut(event.target.value)}
              />
            </label>
            <label>
              划词工具
              <input
                value={selectionShortcut}
                onChange={(event) => setSelectionShortcut(event.target.value)}
              />
            </label>
          </div>
          <div className="settings-actions">
            <button className="ghost-button" onClick={() => void saveShortcuts()}>
              {saved ? '已保存' : '保存快捷键'}
            </button>
            <button className="ghost-button" onClick={() => void onExport()}>
              <Download size={14} />
              导出数据
            </button>
          </div>
        </section>
      </div>
    </Modal>
  )
}
