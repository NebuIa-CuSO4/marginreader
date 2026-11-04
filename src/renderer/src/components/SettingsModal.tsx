import { useState } from 'react'
import { Download, ExternalLink, Monitor, PanelTop, ShieldAlert, Stethoscope } from 'lucide-react'
import type { DeepSeekStatus, Settings } from '../../../shared/types'
import { Modal } from './Modal'

interface SettingsModalProps {
  settings: Settings
  status: DeepSeekStatus
  onChange: (patch: Partial<Settings>) => Promise<void>
  onOpenWeb: () => void
  onHideWeb: () => void
  onExport: () => Promise<void>
  onClose: () => void
}

export function SettingsModal({
  settings,
  status,
  onChange,
  onOpenWeb,
  onHideWeb,
  onExport,
  onClose
}: SettingsModalProps): React.JSX.Element {
  const [toggleShortcut, setToggleShortcut] = useState(settings.toggleShortcut)
  const [screenshotShortcut, setScreenshotShortcut] = useState(settings.screenshotShortcut)
  const [selectionShortcut, setSelectionShortcut] = useState(settings.selectionShortcut)
  const [saved, setSaved] = useState(false)
  const [diagnostic, setDiagnostic] = useState('')
  const [diagnosing, setDiagnosing] = useState(false)

  async function diagnose(): Promise<void> {
    setDiagnosing(true)
    setDiagnostic('')
    try {
      const result = await window.margin.deepseek.diagnose()
      setDiagnostic(JSON.stringify(result, null, 2))
    } catch (error) {
      setDiagnostic(error instanceof Error ? error.message : String(error))
    } finally {
      setDiagnosing(false)
    }
  }

  async function saveShortcuts(): Promise<void> {
    await onChange({ toggleShortcut, screenshotShortcut, selectionShortcut })
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <Modal title="设置" subtitle="侧栏、连接、截图识别和快捷键。" onClose={onClose} wide>
      <div className="settings-sections">
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
          <h4>DeepSeek 网页</h4>
          <div className={`connection-card ${status.phase}`}>
            <span className={`status-dot ${status.phase}`} />
            <div>
              <strong>{status.message}</strong>
              <span>{status.url || '还没有打开网页'}</span>
            </div>
            <div className="connection-actions">
              <button className="ghost-button" onClick={() => void diagnose()} disabled={diagnosing}>
                <Stethoscope size={14} />
                {diagnosing ? '诊断中' : '诊断'}
              </button>
              <button className="ghost-button" onClick={onOpenWeb}>
                <ExternalLink size={14} />
                显示
              </button>
              <button className="ghost-button" onClick={onHideWeb}>
                隐藏
              </button>
            </div>
          </div>
          {diagnostic && <pre className="diagnostic">{diagnostic}</pre>}
          <div className="risk-note">
            <ShieldAlert size={15} />
            <span>这是基于你自己账号的网页桥接，不是 DeepSeek 官方接口。请只用于个人学习，不要高频自动操作。</span>
          </div>
        </section>

        <section>
          <h4>屏幕截图</h4>
          <div className="setting-row">
            <div>
              <strong>OCR 语言</strong>
              <span>仅在网页不接受原图、需要退回文字时使用。英文书建议选 English；中英混排可先用自动。</span>
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
            <span>每次提问自动截取完整屏幕，优先把原图附加到网页对话；网页不接受时回退 OCR 文字</span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.autoSendSelection}
              onChange={(event) => void onChange({ autoSendSelection: event.target.checked })}
            />
            <span>划词后，若已有对话则自动发送翻译 / 解释</span>
          </label>
        </section>

        <section>
          <h4>快捷键</h4>
          <div className="shortcut-grid">
            <label className="field">
              <span>展开 / 收起侧栏</span>
              <input value={toggleShortcut} onChange={(event) => setToggleShortcut(event.target.value)} />
            </label>
            <label className="field">
              <span>截图并附加图片</span>
              <input value={screenshotShortcut} onChange={(event) => setScreenshotShortcut(event.target.value)} />
            </label>
            <label className="field">
              <span>划词翻译 / 解释</span>
              <input value={selectionShortcut} onChange={(event) => setSelectionShortcut(event.target.value)} />
            </label>
          </div>
          <div className="modal-actions compact">
            <span className="saved-note">{saved ? '快捷键已保存' : '使用 CommandOrControl+Shift+… 格式'}</span>
            <button className="ghost-button" onClick={() => void saveShortcuts()}>
              保存快捷键
            </button>
          </div>
        </section>

        <section>
          <h4>数据</h4>
          <div className="setting-row">
            <div>
              <strong>导出备份</strong>
              <span>导出项目、对话镜像、笔记、生词、文件夹和类型为 JSON；不包含截图。</span>
            </div>
            <button className="soft-button" onClick={() => void onExport()}>
              <Download size={15} />
              导出
            </button>
          </div>
        </section>
      </div>
    </Modal>
  )
}
