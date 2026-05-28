/**
 * Stem Session Persistence
 *
 * - Metadata (session list) lives in localStorage for fast listing.
 * - Actual stem audio (Float32 channel data) is stored in OPFS so large
 *   multi-minute 6-stem sessions survive page refresh / browser restart.
 *
 * This makes "navigate into the existing ones" actually useful without
 * forcing the user to re-run the expensive 6-stem separation.
 */

export interface StemSessionMeta {
  id: string

  // For local audio files
  fileName?: string

  // For YouTube videos
  youtubeVideoId?: string
  youtubeVideoTitle?: string

  duration: number
  createdAt: number
  stemNames: string[]
  model: string

  /** User-saved loop presets for this stem session (synced via Drive) */
  presets?: import('./types').LoopPreset[]
}

const STORAGE_KEY = 'weblooper_stem_sessions_v1'
const OPFS_ROOT = 'weblooper-stems'

function generateId(): string {
  return 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9)
}

function readMetaList(): StemSessionMeta[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const list = JSON.parse(raw)
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function writeMetaList(list: StemSessionMeta[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch (e) {
    console.warn('[stems] Failed to write session list to localStorage', e)
  }
}

/**
 * Save a completed stem separation session.
 * Returns the session id.
 * If `overrideId` is provided, uses that instead of generating a new one
 * (used when caching a cloud session locally to preserve the same ID).
 */
export async function saveStemSession(
  partial: Omit<StemSessionMeta, 'id' | 'createdAt'>,
  stems: Array<{ name: string; buffer: AudioBuffer }>,
  overrideId?: string,
): Promise<string> {
  const id = overrideId || generateId()
  const meta: StemSessionMeta = {
    id,
    fileName: partial.fileName,
    youtubeVideoId: partial.youtubeVideoId,
    youtubeVideoTitle: partial.youtubeVideoTitle,
    duration: partial.duration,
    createdAt: Date.now(),
    stemNames: partial.stemNames,
    model: partial.model,
    presets: partial.presets,
  }

  // 1. Persist metadata
  const list = readMetaList()
  // Remove any existing entry with same ID (in case of re-caching)
  const filtered = list.filter(s => s.id !== id)
  // Keep most recent first, cap at 20 sessions
  filtered.unshift(meta)
  if (filtered.length > 20) filtered.length = 20
  writeMetaList(filtered)

  // 2. Persist actual audio in OPFS
  const writtenStems: string[] = []
  const failedStems: Array<{ name: string; reason: string }> = []

  try {
    // Best-effort storage estimate (note: often reports usage=0 on macOS)
    try {
      const estimate = await navigator.storage.estimate?.()
      console.log('[stems] Storage estimate before saving stems:', estimate)
    } catch {}

    const root = await navigator.storage.getDirectory()
    const stemsDir = await root.getDirectoryHandle(OPFS_ROOT, { create: true })
    const sessionDir = await stemsDir.getDirectoryHandle(id, { create: true })

    for (const stem of stems) {
      try {
        const buf = stem.buffer
        const ch = buf.numberOfChannels
        const len = buf.length
        const sr = buf.sampleRate

        // Header is 12 bytes so the following Float32Array starts at a 4-byte aligned offset.
        // Layout:
        //  0-3: sampleRate (uint32, little endian)
        //    4: channels   (uint8)
        //  5-7: reserved/padding
        //  8-11: length     (uint32)
        const headerSize = 12
        const dataSize = ch * len * 4
        const total = headerSize + dataSize

        let bytes: ArrayBuffer
        try {
          bytes = new ArrayBuffer(total)
        } catch (allocErr: any) {
          throw new Error(`Allocation failed for "${stem.name}" (${(total / 1024 / 1024).toFixed(1)} MB): ${allocErr?.message || allocErr}`)
        }

        const view = new DataView(bytes)
        view.setUint32(0, sr, true)
        view.setUint8(4, ch)
        // bytes 5-7 are padding (left as 0)
        view.setUint32(8, len, true)

        const f32 = new Float32Array(bytes, headerSize) // offset 12 → properly aligned
        for (let c = 0; c < ch; c++) {
          f32.set(buf.getChannelData(c), c * len)
        }

        const fileHandle = await sessionDir.getFileHandle(`${stem.name}.pcm`, { create: true })
        const writable = await fileHandle.createWritable()
        await writable.write(bytes)
        await writable.close()

        writtenStems.push(stem.name)
        console.log(`[stems] Wrote stem "${stem.name}" successfully (${(total / 1024 / 1024).toFixed(1)} MB)`)

      } catch (stemErr: any) {
        const reason = stemErr?.message || String(stemErr)
        failedStems.push({ name: stem.name, reason })
        console.error(`[stems] Failed to persist stem "${stem.name}":`, reason)
      }
    }

  } catch (err: any) {
    console.error('[stems] Error preparing OPFS session directory:', err?.message || err)
    failedStems.push({ name: '*', reason: err?.message || String(err) })
  }

  const fullySucceeded = writtenStems.length === stems.length

  if (!fullySucceeded) {
    console.error('[stems] Audio persistence was incomplete.', {
      sessionId: id,
      fileName: meta.fileName,
      requested: stems.map(s => s.name),
      successfullyWritten: writtenStems,
      failures: failedStems
    })

    const err: any = new Error(`Audio persistence failed. Only ${writtenStems.length}/${stems.length} stems written.`)
    err.code = 'AUDIO_PERSISTENCE_FAILED'
    err.sessionId = id
    err.writtenStems = writtenStems
    err.failedStems = failedStems
    throw err
  }

  console.log(`[stems] Successfully persisted all ${writtenStems.length} stems for ${meta.fileName}`)
  return id
}

/**
 * Load a previous session (metadata + reconstructed AudioBuffers).
 */
export async function loadStemSession(id: string): Promise<{
  meta: StemSessionMeta
  stems: Array<{ name: string; buffer: AudioBuffer }>
} | null> {
  const list = readMetaList()
  const meta = list.find(m => m.id === id)
  if (!meta) return null

  const stems: Array<{ name: string; buffer: AudioBuffer }> = []
  const failureReasons: string[] = []

  try {
    const root = await navigator.storage.getDirectory()
    const stemsDir = await root.getDirectoryHandle(OPFS_ROOT, { create: false }).catch(() => null as any)
    if (!stemsDir) {
      failureReasons.push('OPFS root directory "weblooper-stems" does not exist')
      throw new Error('no opfs dir')
    }

    let sessionDir: FileSystemDirectoryHandle
    try {
      sessionDir = await stemsDir.getDirectoryHandle(id, { create: false })
    } catch {
      failureReasons.push(`Session directory for id ${id} not found in OPFS`)
      throw new Error('session dir missing')
    }

    // We need an AudioContext to allocate AudioBuffers
    const AudioCtx = (window.AudioContext || (window as any).webkitAudioContext)
    const ctx = new AudioCtx()

    for (const name of meta.stemNames) {
      let fileHandle: FileSystemFileHandle
      try {
        fileHandle = await sessionDir.getFileHandle(`${name}.pcm`)
      } catch {
        failureReasons.push(`Missing .pcm file for stem "${name}"`)
        continue
      }

      const file = await fileHandle.getFile()
      const bytes = await file.arrayBuffer()

      // New format uses 12-byte header (was 9 bytes before alignment fix)
      if (bytes.byteLength < 12) {
        failureReasons.push(`.pcm file for "${name}" too small (${bytes.byteLength} bytes)`)
        continue
      }

      const view = new DataView(bytes)
      const sr = view.getUint32(0, true)
      const ch = view.getUint8(4)
      const len = view.getUint32(8, true)   // length is now at offset 8

      if (ch === 0 || len === 0) {
        failureReasons.push(`Invalid header for "${name}": channels=${ch}, length=${len}`)
        continue
      }

      const audioBuf = ctx.createBuffer(ch, len, sr)
      const f32 = new Float32Array(bytes, 12)   // data starts at offset 12 (4-byte aligned)

      for (let c = 0; c < ch; c++) {
        const channel = audioBuf.getChannelData(c)
        channel.set(f32.subarray(c * len, c * len + len))
      }

      stems.push({ name, buffer: audioBuf })
    }

    if (stems.length === 0) {
      ctx.close?.()
      console.error('[stems] loadStemSession failed to reconstruct any stems', {
        id,
        meta,
        failureReasons
      })
      return null
    }

    // Success - close the temp context (buffers remain valid)
    try { ctx.close?.() } catch {}

  } catch (err: any) {
    console.error('[stems] loadStemSession failed for', id, {
      error: err?.message || err,
      failureReasons,
      meta
    })
    return null
  }

  return { meta, stems }
}

/** List all known sessions (newest first) */
export function listStemSessions(): StemSessionMeta[] {
  return readMetaList()
}

/** Find a stem session for a specific YouTube video, if any */
export function findStemSessionForYouTubeVideo(videoId: string): StemSessionMeta | undefined {
  const list = readMetaList()
  // Primary lookup: exact youtubeVideoId match
  const exact = list.find(s => s.youtubeVideoId === videoId)
  if (exact) return exact

  // Fallback: sessions saved before the youtubeVideoId fix may only have
  // fileName like "YouTube — <title>" without an explicit videoId.
  // We cannot match by videoId here, but we expose a separate helper for title-based matching.
  return undefined
}

/**
 * Fallback: find a stem session for a YouTube video by matching the video title
 * in the fileName field. Used for stems that were saved before youtubeVideoId was persisted.
 * If found, automatically patches the session metadata with the correct videoId for future lookups.
 */
export function findStemSessionByYouTubeTitle(videoId: string, videoTitle: string): StemSessionMeta | undefined {
  if (!videoTitle) return undefined
  const list = readMetaList()

  // Look for sessions with fileName matching "YouTube — <title>" (exact or partial)
  const normalizedTitle = videoTitle.trim().toLowerCase()
  const match = list.find(s => {
    if (s.youtubeVideoId) return false // already has a videoId, skip
    if (!s.fileName) return false
    const fn = s.fileName.toLowerCase()
    // Match "youtube — <title>" pattern
    if (fn.startsWith('youtube — ') || fn.startsWith('youtube - ')) {
      const titlePart = fn.replace(/^youtube\s*[—-]\s*/, '').trim()
      return titlePart === normalizedTitle || normalizedTitle.includes(titlePart) || titlePart.includes(normalizedTitle)
    }
    return false
  })

  if (match) {
    // Patch the session metadata so future lookups work by videoId directly
    match.youtubeVideoId = videoId
    match.youtubeVideoTitle = videoTitle
    const updatedList = list.map(s => s.id === match.id ? match : s)
    writeMetaList(updatedList)
    console.log('[stems] Patched session', match.id, 'with youtubeVideoId:', videoId)
  }

  return match
}

/** Delete a session (metadata + OPFS files) */
export async function deleteStemSession(id: string): Promise<void> {
  const list = readMetaList().filter(m => m.id !== id)
  writeMetaList(list)

  try {
    const root = await navigator.storage.getDirectory()
    const stemsDir = await root.getDirectoryHandle(OPFS_ROOT, { create: false })
    await stemsDir.removeEntry(id, { recursive: true })
  } catch {
    // ignore if already gone
  }
}

/**
 * Update the saved presets for an existing stem session (used when user saves
 * loops while in stem practice view). This keeps presets in the central meta
 * so they travel with cloud sync.
 */
export function updateStemSessionPresets(id: string, presets: import('./types').LoopPreset[]): void {
  const list = readMetaList()
  const idx = list.findIndex(m => m.id === id)
  if (idx >= 0) {
    list[idx] = { ...list[idx], presets: [...presets] }
    writeMetaList(list)
  }
}
