/**
 * Local CLI stem separation — job payload + command helpers.
 *
 * The static site creates a Drive session (SSO already done), then hands the user
 * a single `uvx weblooper-stems run …` command. The CLI downloads YouTube audio,
 * runs native Demucs, and updates the Drive placeholders. The site polls as with Colab.
 */

/** Pin CLI version so site-generated commands stay compatible. */
export const WEBLOOPER_STEMS_CLI_VERSION = '0.1.0'

export const WEBLOOPER_STEMS_PACKAGE = 'weblooper-stems'

/**
 * Install source for `uvx --from …`.
 * Uses the monorepo until the package is published to PyPI.
 * Switch to plain `weblooper-stems@VERSION` after `uv publish`.
 */
export const WEBLOOPER_STEMS_UVX_FROM =
  'git+https://github.com/schardosin/weblooper.git@main#subdirectory=cli/weblooper-stems'

export const LOCAL_CLI_PAYLOAD_VERSION = 1

export const SIX_STEM_NAMES = ['drums', 'bass', 'guitar', 'piano', 'vocals', 'other'] as const

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

/**
 * Full one-liner for Terminal.
 * Leading space helps shells with HISTCONTROL=ignorespace skip history.
 */
export function formatUvxCommand(job: LocalCliJobPayload): string {
  const payload = encodeJobPayload(job)
  return ` uvx --from "${WEBLOOPER_STEMS_UVX_FROM}" ${WEBLOOPER_STEMS_PACKAGE} run '${payload}'`
}

/** Shorter command when the user downloaded a job JSON file. */
export function formatUvxJobFileCommand(fileName: string): string {
  const path = fileName.includes('/') || fileName.startsWith('~')
    ? fileName
    : `~/Downloads/${fileName}`
  return ` uvx --from "${WEBLOOPER_STEMS_UVX_FROM}" ${WEBLOOPER_STEMS_PACKAGE} run ${path}`
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

export const UV_INSTALL_COMMAND =
  'curl -LsSf https://astral.sh/uv/install.sh | sh'
