/**
 * Google Drive Sync — Upload/download stem sessions to/from appDataFolder.
 *
 * Storage structure in appDataFolder:
 *   manifest.json              — List of all synced sessions (lightweight)
 *   stems/<session-id>/        — Folder per session
 *     meta.json                — Session metadata
 *     vocals.webm              — Opus-encoded stem audio
 *     drums.webm
 *     bass.webm
 *     guitar.webm
 *     piano.webm
 *     other.webm
 *
 * Upload happens in background after stem separation completes.
 * Download happens on-demand when a user opens a cloud session.
 */

import { getValidToken, isSignedIn } from './auth'
import * as drive from './client'
import type { StemSessionMeta } from '../stems/persistence'

export interface CloudSession extends StemSessionMeta {
  /** Google Drive folder ID for this session */
  driveFolderId: string
  /** Whether the session exists locally in OPFS */
  isLocal?: boolean
}

interface CloudManifest {
  version: number
  sessions: CloudSession[]
}

// Cache the manifest in memory to avoid repeated fetches
let manifestCache: CloudManifest | null = null
let manifestFileId: string | null = null

// ---------- Manifest Management ----------

/**
 * Fetch the cloud manifest (list of all synced sessions).
 * Returns empty if not signed in or manifest doesn't exist yet.
 */
export async function fetchCloudSessions(): Promise<CloudSession[]> {
  if (!isSignedIn()) return []

  try {
    const token = await getValidToken()

    // Find the manifest file
    const file = await drive.findFileByName(token, 'manifest.json')
    if (!file) {
      manifestCache = { version: 1, sessions: [] }
      return []
    }

    manifestFileId = file.id
    const text = await drive.downloadFileAsText(token, file.id)
    const manifest: CloudManifest = JSON.parse(text)
    manifestCache = manifest
    return manifest.sessions || []
  } catch (err) {
    console.error('[drive-sync] Failed to fetch cloud sessions:', err)
    return []
  }
}

/**
 * Save the manifest to Drive (create or update).
 */
async function saveManifest(token: string): Promise<void> {
  if (!manifestCache) return

  const json = JSON.stringify(manifestCache, null, 2)

  if (manifestFileId) {
    await drive.updateFile(token, manifestFileId, json, 'application/json')
  } else {
    manifestFileId = await drive.uploadFile(token, 'manifest.json', json, 'application/json')
  }
}

// ---------- Upload ----------

export interface UploadProgress {
  phase: 'encoding' | 'uploading' | 'done' | 'error'
  message: string
  percent?: number
  stemIndex?: number
  totalStems?: number
}

/**
 * Upload a stem session to Google Drive (background, non-blocking).
 *
 * Call this after stems are saved locally to OPFS.
 * Encodes each stem to Opus/WebM before uploading (massive size reduction).
 */
export async function uploadStemSession(
  meta: StemSessionMeta,
  stems: Array<{ name: string; buffer: AudioBuffer }>,
  onProgress?: (p: UploadProgress) => void,
): Promise<void> {
  if (!isSignedIn()) {
    console.log('[drive-sync] Not signed in — skipping cloud upload')
    return
  }

  try {
    const token = await getValidToken()

    // Check if already uploaded (by session ID in manifest)
    if (manifestCache?.sessions.some(s => s.id === meta.id)) {
      console.log('[drive-sync] Session already in cloud:', meta.id)
      return
    }

    onProgress?.({ phase: 'encoding', message: 'Encoding stems for upload...', percent: 0 })

    // Create a folder for this session
    const folderId = await drive.createFolder(token, meta.id)

    // Upload meta.json
    await drive.uploadFile(token, 'meta.json', JSON.stringify(meta, null, 2), 'application/json', folderId)

    // Encode and upload each stem
    const { encodeToOpusWebM, isOpusEncoderSupported } = await import('../audio/opus-encoder')

    if (!isOpusEncoderSupported()) {
      onProgress?.({ phase: 'error', message: 'Opus encoder not supported in this browser' })
      console.warn('[drive-sync] AudioEncoder not available — cannot encode stems for upload')
      return
    }

    for (let i = 0; i < stems.length; i++) {
      const stem = stems[i]
      const stemName = stem.name

      onProgress?.({
        phase: 'encoding',
        message: `Encoding ${stemName}...`,
        percent: Math.round((i / stems.length) * 50),
        stemIndex: i,
        totalStems: stems.length,
      })

      // Encode to Opus/WebM
      const encoded = await encodeToOpusWebM(stem.buffer, {
        bitrate: 128_000,
        onProgress: (p) => {
          const basePercent = (i / stems.length) * 50
          const stemPercent = (p / 100) * (50 / stems.length)
          onProgress?.({
            phase: 'encoding',
            message: `Encoding ${stemName}... ${p}%`,
            percent: Math.round(basePercent + stemPercent),
            stemIndex: i,
            totalStems: stems.length,
          })
        },
      })

      // Upload the encoded stem
      onProgress?.({
        phase: 'uploading',
        message: `Uploading ${stemName}...`,
        percent: Math.round(50 + (i / stems.length) * 50),
        stemIndex: i,
        totalStems: stems.length,
      })

      await drive.uploadFile(token, `${stemName}.webm`, encoded, 'audio/webm', folderId)
    }

    // Update manifest
    if (!manifestCache) {
      manifestCache = { version: 1, sessions: [] }
    }

    const cloudSession: CloudSession = {
      ...meta,
      driveFolderId: folderId,
    }
    manifestCache.sessions.unshift(cloudSession)

    // Cap at 50 sessions in cloud
    if (manifestCache.sessions.length > 50) {
      manifestCache.sessions.length = 50
    }

    await saveManifest(token)

    onProgress?.({ phase: 'done', message: 'Uploaded to cloud', percent: 100 })
    console.log(`[drive-sync] Successfully uploaded session "${meta.fileName}" to Drive`)

  } catch (err: any) {
    console.error('[drive-sync] Upload failed:', err)
    onProgress?.({ phase: 'error', message: `Upload failed: ${err.message}` })
  }
}

// ---------- Download ----------

export interface DownloadProgress {
  phase: 'downloading' | 'decoding' | 'done' | 'error'
  message: string
  percent?: number
}

/**
 * Download a stem session from Google Drive.
 * Returns decoded AudioBuffers ready for the stem player.
 */
export async function downloadStemSession(
  session: CloudSession,
  onProgress?: (p: DownloadProgress) => void,
): Promise<Array<{ name: string; buffer: AudioBuffer }> | null> {
  if (!isSignedIn()) return null

  try {
    const token = await getValidToken()

    // List files in the session folder
    const files = await drive.listFiles(token, `'${session.driveFolderId}' in parents and trashed = false`)

    const stemFiles = files.filter(f => f.name.endsWith('.webm'))
    if (stemFiles.length === 0) {
      onProgress?.({ phase: 'error', message: 'No stem files found in cloud session' })
      return null
    }

    const stems: Array<{ name: string; buffer: AudioBuffer }> = []
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()

    for (let i = 0; i < stemFiles.length; i++) {
      const file = stemFiles[i]
      const stemName = file.name.replace('.webm', '')

      onProgress?.({
        phase: 'downloading',
        message: `Downloading ${stemName}...`,
        percent: Math.round((i / stemFiles.length) * 70),
      })

      // Download the WebM file
      const data = await drive.downloadFile(token, file.id)

      onProgress?.({
        phase: 'decoding',
        message: `Decoding ${stemName}...`,
        percent: Math.round(70 + (i / stemFiles.length) * 30),
      })

      // Decode WebM/Opus → AudioBuffer
      const audioBuffer = await audioContext.decodeAudioData(data)
      stems.push({ name: stemName, buffer: audioBuffer })
    }

    try { audioContext.close?.() } catch {}

    onProgress?.({ phase: 'done', message: 'Download complete', percent: 100 })
    return stems

  } catch (err: any) {
    console.error('[drive-sync] Download failed:', err)
    onProgress?.({ phase: 'error', message: `Download failed: ${err.message}` })
    return null
  }
}

/**
 * Delete a session from the cloud.
 */
export async function deleteCloudSession(sessionId: string): Promise<void> {
  if (!isSignedIn()) return

  try {
    const token = await getValidToken()

    // Find the session in manifest
    const session = manifestCache?.sessions.find(s => s.id === sessionId)
    if (session?.driveFolderId) {
      await drive.deleteFile(token, session.driveFolderId)
    }

    // Update manifest
    if (manifestCache) {
      manifestCache.sessions = manifestCache.sessions.filter(s => s.id !== sessionId)
      await saveManifest(token)
    }
  } catch (err) {
    console.error('[drive-sync] Failed to delete cloud session:', err)
  }
}

/**
 * Check if a session exists in the cloud.
 */
export function isSessionInCloud(sessionId: string): boolean {
  return manifestCache?.sessions.some(s => s.id === sessionId) ?? false
}

// ============================================
// Video State Sync (lightweight JSON — no binary data)
// ============================================

export interface CloudVideoState {
  videoId: string
  title?: string
  lastVisited?: number
  duration?: number
  start?: number
  end?: number
  isLooping?: boolean
  playbackRate?: number
  presets?: any[]
  [key: string]: any
}

interface VideoStatesFile {
  version: number
  states: Record<string, CloudVideoState>
}

// Cache
let videoStatesCache: VideoStatesFile | null = null
let videoStatesFileId: string | null = null

const VIDEO_STATES_FILENAME = 'video-states.json'

/**
 * Fetch video states from cloud (single small JSON file).
 * Returns empty object if not signed in or file doesn't exist.
 */
export async function fetchCloudVideoStates(): Promise<Record<string, CloudVideoState>> {
  if (!isSignedIn()) return {}

  try {
    const token = await getValidToken()

    const file = await drive.findFileByName(token, VIDEO_STATES_FILENAME)
    if (!file) {
      videoStatesCache = { version: 1, states: {} }
      return {}
    }

    videoStatesFileId = file.id
    const text = await drive.downloadFileAsText(token, file.id)
    const data: VideoStatesFile = JSON.parse(text)

    // Sanitize on read so even previously polluted cloud data is cleaned when used
    const allowedKeys = ['videoId', 'title', 'duration', 'start', 'end', 'isLooping', 'playbackRate', 'presets', 'lastVisited']
    const cleaned: Record<string, any> = {}
    for (const [id, raw] of Object.entries(data.states || {})) {
      if (!raw || typeof raw !== 'object') continue
      const clean: any = {}
      for (const k of allowedKeys) {
        if (k in raw) clean[k] = (raw as any)[k]
      }
      if ((raw as any).videoId) clean.videoId = (raw as any).videoId
      cleaned[id] = clean
    }

    videoStatesCache = { ...data, states: cleaned }
    return cleaned
  } catch (err) {
    console.error('[drive-sync] Failed to fetch cloud video states:', err)
    return {}
  }
}

/**
 * Upload (or update) the full video states map to Drive.
 */
export async function uploadVideoStates(states: Record<string, any>): Promise<void> {
  if (!isSignedIn()) return

  try {
    const token = await getValidToken()

    // Sanitize all states before upload to strip any UI-only fields that may have leaked
    // (e.g. "source" from merging logic on any client).
    const cleanStates: Record<string, any> = {}
    const allowedKeys = ['videoId', 'title', 'duration', 'start', 'end', 'isLooping', 'playbackRate', 'presets', 'lastVisited']
    for (const [id, raw] of Object.entries(states || {})) {
      if (!raw || typeof raw !== 'object') continue
      const clean: any = {}
      for (const k of allowedKeys) {
        if (k in raw) clean[k] = (raw as any)[k]
      }
      if ((raw as any).videoId) clean.videoId = (raw as any).videoId
      cleanStates[id] = clean
    }

    const payload: VideoStatesFile = {
      version: 1,
      states: cleanStates,
    }
    const json = JSON.stringify(payload, null, 2)

    if (videoStatesFileId) {
      await drive.updateFile(token, videoStatesFileId, json, 'application/json')
    } else {
      // Try to find existing first (in case cache is stale)
      const existing = await drive.findFileByName(token, VIDEO_STATES_FILENAME)
      if (existing) {
        videoStatesFileId = existing.id
        await drive.updateFile(token, existing.id, json, 'application/json')
      } else {
        videoStatesFileId = await drive.uploadFile(token, VIDEO_STATES_FILENAME, json, 'application/json')
      }
    }

    videoStatesCache = { version: 1, states: cleanStates }
    console.log('[drive-sync] Video states uploaded to cloud')
  } catch (err) {
    console.error('[drive-sync] Failed to upload video states:', err)
  }
}

/**
 * Delete a single video's state from the cloud file.
 */
export async function deleteCloudVideoState(videoId: string): Promise<void> {
  if (!isSignedIn()) return

  try {
    const token = await getValidToken()

    if (!videoStatesCache) {
      await fetchCloudVideoStates()
    }

    if (videoStatesCache) {
      delete videoStatesCache.states[videoId]

      const json = JSON.stringify(videoStatesCache, null, 2)
      if (videoStatesFileId) {
        await drive.updateFile(token, videoStatesFileId, json, 'application/json')
      }
    }
  } catch (err) {
    console.error('[drive-sync] Failed to delete cloud video state:', err)
  }
}

/**
 * Check (from cache) whether a videoId exists in the cloud video states.
 */
export function isVideoInCloud(videoId: string): boolean {
  return !!(videoStatesCache?.states?.[videoId])
}

// ============================================
// Stem Session Meta Updates (for syncing presets etc. without re-uploading audio)
// ============================================

/**
 * Update metadata for an existing cloud stem session (e.g. to push newly saved
 * loop presets). This updates both the per-session meta.json and the root manifest.
 */
export async function updateCloudStemMeta(
  sessionId: string,
  updates: Partial<StemSessionMeta>
): Promise<void> {
  if (!isSignedIn()) return

  try {
    const token = await getValidToken()

    // Find session in manifest
    const sessionIndex = manifestCache?.sessions.findIndex(s => s.id === sessionId) ?? -1
    if (sessionIndex < 0 || !manifestCache) {
      console.warn('[drive-sync] Cannot update meta for unknown cloud session', sessionId)
      return
    }

    const session = manifestCache.sessions[sessionIndex]
    const updatedSession: CloudSession = {
      ...session,
      ...updates,
      // Preserve critical fields
      driveFolderId: session.driveFolderId,
    }

    manifestCache.sessions[sessionIndex] = updatedSession

    // Re-upload the small meta.json inside the session folder
    if (session.driveFolderId) {
      const metaPayload = {
        id: updatedSession.id,
        fileName: updatedSession.fileName,
        youtubeVideoId: updatedSession.youtubeVideoId,
        youtubeVideoTitle: updatedSession.youtubeVideoTitle,
        duration: updatedSession.duration,
        createdAt: updatedSession.createdAt,
        stemNames: updatedSession.stemNames,
        model: updatedSession.model,
        presets: updatedSession.presets,
      }
      await drive.uploadFile(
        token,
        'meta.json',
        JSON.stringify(metaPayload, null, 2),
        'application/json',
        session.driveFolderId
      )
    }

    // Save updated manifest
    await saveManifest(token)

    console.log('[drive-sync] Updated cloud stem meta for', sessionId)
  } catch (err) {
    console.error('[drive-sync] Failed to update cloud stem meta:', err)
  }
}
