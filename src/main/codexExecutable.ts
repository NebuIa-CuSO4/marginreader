import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { basename, delimiter, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)

async function desktopInstallations(): Promise<string[]> {
  const systemRoot = process.env.SystemRoot
  if (!systemRoot || !isAbsolute(systemRoot)) return []
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  try {
    const { stdout } = await runFile(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8; (Get-AppxPackage -Name OpenAI.Codex).InstallLocation'
    ], { windowsHide: true, timeout: 5_000, maxBuffer: 16_384, encoding: 'utf8' })
    return stdout.trim().split(/\r?\n/).filter(isAbsolute)
  } catch {
    return []
  }
}

async function cachedDesktopExecutables(localAppData: string): Promise<string[]> {
  const root = join(localAppData, 'OpenAI', 'Codex', 'bin')
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const files = await Promise.all(entries.filter((entry) => entry.isDirectory() && /^[\da-f]{16}$/i.test(entry.name))
    .map(async (entry) => {
      const path = join(root, entry.name, 'codex.exe')
      const info = await stat(path).catch(() => null)
      return info?.isFile() ? { path, modifiedAt: info.mtimeMs } : null
    }))
  return files.flatMap((file) => file ? [file] : [])
    .sort((a, b) => b.modifiedAt - a.modifiedAt).map((file) => file.path)
}

export async function* codexExecutables(): AsyncGenerator<string> {
  const pathDirs = (process.env.PATH ?? '').split(delimiter)
    .map((directory) => directory.trim().replace(/^"|"$/g, ''))
    .filter(isAbsolute)
  const local = process.env.LOCALAPPDATA
  const roaming = process.env.APPDATA
  const target = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  const npmPlatform = process.arch === 'arm64' ? 'arm64' : 'x64'
  const npmRoots = new Set([...pathDirs, ...(roaming ? [join(roaming, 'npm')] : [])])
  const seen = new Set<string>()

  async function* existing(paths: string[]): AsyncGenerator<string> {
    for (const path of paths) {
      const key = path.toLowerCase()
      if (!isAbsolute(path) || basename(key) !== 'codex.exe' || seen.has(key)) continue
      seen.add(key)
      if ((await stat(path).catch(() => null))?.isFile()) yield path
    }
  }

  yield* existing([
    process.env.CODEX_CLI_PATH?.trim().replace(/^"|"$/g, '') ?? '',
    ...(local ? [join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')] : []),
    ...pathDirs.map((directory) => join(directory, 'codex.exe'))
  ])
  yield* existing([...npmRoots].flatMap((prefix) => {
    const modules = join(prefix, 'node_modules', '@openai')
    const vendorBin = ['vendor', target + '-pc-windows-msvc', 'bin', 'codex.exe']
    const platform = 'codex-win32-' + npmPlatform
    return [
      join(modules, 'codex', 'node_modules', '@openai', platform, ...vendorBin),
      join(modules, platform, ...vendorBin),
      join(modules, 'codex', ...vendorBin)
    ]
  }))

  const installations = await desktopInstallations()
  yield* existing(installations.map((directory) => join(directory, 'app', 'resources', 'codex.exe')))
  if (local) yield* existing(await cachedDesktopExecutables(local))
}
