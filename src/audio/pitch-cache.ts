/**
 * Pitch Cache — Stores raw captured audio and pre-generated pitch-shifted versions.
 *
 * Storage layout in OPFS:
 *   weblooper-pitch/
 *     <videoId>/
 *       raw.webm          — Opus-encoded raw captured audio (full mix, original key)
 *       pitch_+1.webm     — Opus-encoded audio shifted +1 semitone
 *       pitch_-2.webm     — Opus-encoded audio shifted -2 semitones
 *       ...
 *
 * Metadata (which keys have been generated) is tracked in localStorage.
 */

const OPFS_ROOT = 'weblooper-pitch'
const META_KEY = 'weblooper_pitch_cache_v1'

export interface PitchCacheMeta {
  videoId: string
  /** Duration of the raw audio in seconds */
  duration: number
  /** List of pitch shifts that have been generated (e.g. [1, -1, 2, -2]) */
  generatedKeys: number[]
  /** Whether the raw audio has been captured and stored */
  hasRaw: boolean
  createdAt: number
}

// ────────────────────────────────────────────────────────────────
// Metadata (localStorage)
// ────────────────────────────────────────────────────────────────

function readMetaList(): PitchCacheMeta[] {
  try {
    const raw = localStorage.getItem(META_KEY)
    if (!raw) return []
    return JSON.parse(raw) ?? []
  } catch {
    return []
  }
}

function writeMetaList(list: PitchCacheMeta[]) {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(list))
  } catch (e) {
    console.warn('[pitch-cache] Failed to write metadata', e)
  }
}

export function getPitchCacheMeta(videoId: string): PitchCacheMeta | undefined {
  return readMetaList().find(m => m.videoId === videoId)
}

function upsertMeta(meta: PitchCacheMeta) {
  const list = readMetaList()
  const idx = list.findIndex(m => m.videoId === meta.videoId)
  if (idx >= 0) {
    list[idx] = meta
  } else {
    list.unshift(meta)
    if (list.length > 50) list.length = 50
  }
  writeMetaList(list)
}

// ────────────────────────────────────────────────────────────────
// OPFS Storage
// ────────────────────────────────────────────────────────────────

async function getVideoDir(videoId: string, create = true): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  const pitchDir = await root.getDirectoryHandle(OPFS_ROOT, { create })
  return await pitchDir.getDirectoryHandle(videoId, { create })
}

function pitchFileName(semitones: number): string {
  const sign = semitones > 0 ? '+' : ''
  return `pitch_${sign}${semitones}.webm`
}

/**
 * Save raw captured audio (Opus-encoded) to OPFS.
 */
export async function saveRawAudio(videoId: string, opusData: ArrayBuffer, duration: number): Promise<void> {
  const dir = await getVideoDir(videoId)
  const file = await dir.getFileHandle('raw.webm', { create: true })
  const writable = await file.createWritable()
  await writable.write(opusData)
  await writable.close()

  const meta = getPitchCacheMeta(videoId) || {
    videoId,
    duration,
    generatedKeys: [],
    hasRaw: false,
    createdAt: Date.now(),
  }
  meta.hasRaw = true
  meta.duration = duration
  upsertMeta(meta)

  console.log(`[pitch-cache] Saved raw audio for ${videoId} (${(opusData.byteLength / 1024).toFixed(0)} KB)`)
}

/**
 * Load raw captured audio from OPFS. Returns null if not found.
 */
export async function loadRawAudio(videoId: string): Promise<ArrayBuffer | null> {
  try {
    const dir = await getVideoDir(videoId, false)
    const file = await dir.getFileHandle('raw.webm')
    const blob = await file.getFile()
    return await blob.arrayBuffer()
  } catch {
    return null
  }
}

/**
 * Check if raw audio exists for this video (fast, metadata only).
 */
export function hasRawAudio(videoId: string): boolean {
  const meta = getPitchCacheMeta(videoId)
  return meta?.hasRaw ?? false
}

/**
 * Save a pitch-shifted version (Opus-encoded) to OPFS.
 */
export async function savePitchedAudio(videoId: string, semitones: number, opusData: ArrayBuffer): Promise<void> {
  const dir = await getVideoDir(videoId)
  const file = await dir.getFileHandle(pitchFileName(semitones), { create: true })
  const writable = await file.createWritable()
  await writable.write(opusData)
  await writable.close()

  const meta = getPitchCacheMeta(videoId)
  if (meta) {
    if (!meta.generatedKeys.includes(semitones)) {
      meta.generatedKeys.push(semitones)
      meta.generatedKeys.sort((a, b) => a - b)
    }
    upsertMeta(meta)
  }

  console.log(`[pitch-cache] Saved pitch ${semitones > 0 ? '+' : ''}${semitones} for ${videoId} (${(opusData.byteLength / 1024).toFixed(0)} KB)`)
}

/**
 * Load a pitch-shifted version from OPFS. Returns null if not generated yet.
 */
export async function loadPitchedAudio(videoId: string, semitones: number): Promise<ArrayBuffer | null> {
  try {
    const dir = await getVideoDir(videoId, false)
    const file = await dir.getFileHandle(pitchFileName(semitones))
    const blob = await file.getFile()
    return await blob.arrayBuffer()
  } catch {
    return null
  }
}

/**
 * Check if a specific pitch-shifted version exists (fast, metadata only).
 */
export function hasPitchedAudio(videoId: string, semitones: number): boolean {
  const meta = getPitchCacheMeta(videoId)
  return meta?.generatedKeys.includes(semitones) ?? false
}

/**
 * Delete all pitch cache data for a video.
 */
export async function deletePitchCache(videoId: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory()
    const pitchDir = await root.getDirectoryHandle(OPFS_ROOT, { create: false })
    await pitchDir.removeEntry(videoId, { recursive: true })
  } catch {
    // ignore if already gone
  }
  const list = readMetaList().filter(m => m.videoId !== videoId)
  writeMetaList(list)
}
