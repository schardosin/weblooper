/**
 * Local CLI stem separation — job payload + command helpers.
 *
 * The static site creates a Drive session (SSO already done), then hands the user
 * a single `uvx weblooper-stems run …` command. The CLI downloads YouTube audio,
 * runs native Demucs, and updates the Drive placeholders. The site polls as with Colab.
 *
 * Only host prerequisite: `uv` / `uvx`. Python deps install into an isolated cache.
 * Commands are OS-aware (macOS / Linux / Windows PowerShell).
 */

/** Pin CLI version so site-generated commands stay compatible. */
export const WEBLOOPER_STEMS_CLI_VERSION = '0.1.1'

export const WEBLOOPER_STEMS_PACKAGE = 'weblooper-stems'

/**
 * Install source for `uvx --from …`.
 * Uses the monorepo until the package is published to PyPI.
 * Switch to plain `weblooper-stems@VERSION` after `uv publish`.
 *
 * Note: git+ requires Git on PATH (including Git for Windows). After PyPI publish this goes away.
 */
export const WEBLOOPER_STEMS_UVX_FROM =
  'git+https://github.com/schardosin/weblooper.git@main#subdirectory=cli/weblooper-stems'

export const LOCAL_CLI_PAYLOAD_VERSION = 1

export const SIX_STEM_NAMES = ['drums', 'bass', 'guitar', 'piano', 'vocals', 'other'] as const

export type HostOs = 'macos' | 'windows' | 'linux' | 'unknown'

export interface LocalCliJobPayload {
  v: number
  folderId: string
  sessionId: string
  youtubeUrl: string
  youtubeVideoId: string
  title: string
  accessToken: string
  tokenExpiresAt: number
  model: string
  stemNames: string[]
  createdAt: number
}

export function buildLocalCliJob(params: {
  folderId: string
  sessionId: string
  youtubeVideoId: string
  title: string
  accessToken: string
  tokenExpiresAt: number
  model?: string
}): LocalCliJobPayload {
  return {
    v: LOCAL_CLI_PAYLOAD_VERSION,
    folderId: params.folderId,
    sessionId: params.sessionId,
    youtubeUrl: `https://www.youtube.com/watch?v=${params.youtubeVideoId}`,
    youtubeVideoId: params.youtubeVideoId,
    title: params.title,
    accessToken: params.accessToken,
    tokenExpiresAt: params.tokenExpiresAt,
    model: params.model || 'htdemucs_6s',
    stemNames: [...SIX_STEM_NAMES],
    createdAt: Date.now(),
  }
}

/** base64url encode (no padding) for a single shell-safe argument. */
export function encodeJobPayload(job: LocalCliJobPayload): string {
  const json = JSON.stringify(job)
  const bytes = new TextEncoder().encode(json)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  const b64 = btoa(binary)
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeJobPayload(encoded: string): LocalCliJobPayload {
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
  const binary = atob(b64 + pad)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as LocalCliJobPayload
}

/** Best-effort OS detection from the browser (for install + command wording). */
export function detectHostOs(): HostOs {
  const nav = typeof navigator !== 'undefined' ? navigator : null
  if (!nav) return 'unknown'

  // Prefer User-Agent Client Hints when available
  const uaData = (nav as Navigator & { userAgentData?: { platform?: string } }).userAgentData
  const platformHint = (uaData?.platform || nav.platform || '').toLowerCase()
  const ua = (nav.userAgent || '').toLowerCase()

  if (platformHint.includes('win') || ua.includes('windows')) return 'windows'
  if (platformHint.includes('mac') || ua.includes('mac os') || ua.includes('macintosh')) return 'macos'
  if (
    platformHint.includes('linux') ||
    platformHint.includes('chrome os') ||
    ua.includes('linux') ||
    ua.includes('cros')
  ) {
    return 'linux'
  }
  return 'unknown'
}

export function hostOsLabel(os: HostOs = detectHostOs()): string {
  switch (os) {
    case 'macos':
      return 'macOS'
    case 'windows':
      return 'Windows'
    case 'linux':
      return 'Linux'
    default:
      return 'your OS'
  }
}

/** One-time uv install command for the detected (or given) OS. */
export function getUvInstallCommand(os: HostOs = detectHostOs()): string {
  if (os === 'windows') {
    return 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"'
  }
  // macOS + Linux + unknown (curl is the official non-Windows path)
  return 'curl -LsSf https://astral.sh/uv/install.sh | sh'
}

/** @deprecated Use getUvInstallCommand() — kept for older imports. */
export const UV_INSTALL_COMMAND = getUvInstallCommand('macos')

function uvxFromPrefix(): string {
  return `uvx --from "${WEBLOOPER_STEMS_UVX_FROM}" ${WEBLOOPER_STEMS_PACKAGE}`
}

/**
 * Full one-liner for Terminal / PowerShell.
 * - Unix: leading space helps HISTCONTROL=ignorespace; single-quoted payload
 * - Windows PowerShell: single-quoted payload (literal); no leading space needed
 */
export function formatUvxCommand(
  job: LocalCliJobPayload,
  os: HostOs = detectHostOs(),
): string {
  const payload = encodeJobPayload(job)
  const core = `${uvxFromPrefix()} run`
  if (os === 'windows') {
    // PowerShell: single quotes = literal string (safe for base64url payload)
    return `${core} '${payload}'`
  }
  // bash/zsh: leading space for history ignore when HISTCONTROL=ignorespace
  return ` ${core} '${payload}'`
}

/** Path hint for a downloaded job file on the given OS. */
export function jobFilePathHint(fileName: string, os: HostOs = detectHostOs()): string {
  if (
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.startsWith('~') ||
    fileName.startsWith('$')
  ) {
    return fileName
  }
  if (os === 'windows') {
    return `$env:USERPROFILE\\Downloads\\${fileName}`
  }
  return `~/Downloads/${fileName}`
}

/** Command when the user downloaded a job JSON file. */
export function formatUvxJobFileCommand(
  fileName: string,
  os: HostOs = detectHostOs(),
): string {
  const path = jobFilePathHint(fileName, os)
  const core = `${uvxFromPrefix()} run ${path}`
  return os === 'windows' ? core : ` ${core}`
}

export function jobFileName(sessionId: string): string {
  const short = sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'job'
  return `weblooper-job-${short}.json`
}

/** Trigger a browser download of the job JSON (token stays out of argv when using file mode). */
export function downloadJobFile(job: LocalCliJobPayload): string {
  const name = jobFileName(job.sessionId)
  const blob = new Blob([JSON.stringify(job, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2_000)
  return name
}

/** Copy for the local-CLI modal: steps, notes, primary CTA preference. */
export function getLocalCliUiCopy(os: HostOs = detectHostOs()): {
  os: HostOs
  osLabel: string
  installCommand: string
  installShell: string
  runShell: string
  preferJobFile: boolean
  commandHint: string
  footerNote: string
} {
  const osLabel = hostOsLabel(os)
  if (os === 'windows') {
    return {
      os,
      osLabel,
      installCommand: getUvInstallCommand('windows'),
      installShell: 'PowerShell',
      runShell: 'PowerShell',
      preferJobFile: true,
      commandHint:
        'Use PowerShell (not cmd.exe). Prefer “Download job file” if the one-liner is awkward. After installing uv, open a new terminal. Requires Git for Windows on PATH until the package is on PyPI. Token expires in ~1 hour.',
      footerNote:
        'Isolated install via uvx — only host tool needed is uv. First run downloads PyTorch + Demucs (large). Windows uses CPU by default (CUDA is optional/advanced).',
    }
  }
  if (os === 'macos') {
    return {
      os,
      osLabel,
      installCommand: getUvInstallCommand('macos'),
      installShell: 'Terminal',
      runShell: 'Terminal',
      preferJobFile: false,
      commandHint:
        'Leading space helps keep the token out of shell history when HISTCONTROL=ignorespace is set. Token expires in ~1 hour. Git is required for the git+ install source.',
      footerNote:
        'Isolated install via uvx — only host tool needed is uv. First run downloads PyTorch + Demucs. Uses Apple MPS when available.',
    }
  }
  // linux / unknown
  return {
    os,
    osLabel,
    installCommand: getUvInstallCommand('linux'),
    installShell: 'Terminal',
    runShell: 'Terminal',
    preferJobFile: false,
    commandHint:
      'Leading space helps keep the token out of shell history when HISTCONTROL=ignorespace is set. Token expires in ~1 hour. Git is required for the git+ install source.',
    footerNote:
      'Isolated install via uvx — only host tool needed is uv. First run downloads PyTorch + Demucs. Uses CUDA if a CUDA build of torch is present; otherwise CPU.',
  }
}
