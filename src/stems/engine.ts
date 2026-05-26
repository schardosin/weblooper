/**
 * StemEngine — 6-stem only via demucs-rs (htdemucs_6s).
 *
 * Full stems: drums, bass, guitar, piano, vocals, other.
 * This is the exclusive separation engine for weblooper.
 */

import type { StemEngine } from './types'
import { separateWithDemucsRs, isDemucsRsSupported, getDemucsRsModelLabel } from './demucs-rs-adapter'

/**
 * The one and only stem separation engine: demucs-rs + htdemucs_6s.
 * Full 6 stems: drums, bass, guitar, piano, vocals, other.
 */
class DemucsRsEngine implements StemEngine {
  private model: 'htdemucs' | 'htdemucs_6s' | 'htdemucs_ft' = 'htdemucs_6s'

  constructor(model: 'htdemucs' | 'htdemucs_6s' | 'htdemucs_ft' = 'htdemucs_6s') {
    this.model = model
  }

  async isSupported(): Promise<boolean> {
    return isDemucsRsSupported()
  }

  getName(): string {
    return `demucs-rs 6-stem (${getDemucsRsModelLabel(this.model)})`
  }

  async estimateProcessingTime(audioDurationSec: number): Promise<number> {
    return Math.ceil(audioDurationSec * 1.0)
  }

  async separate(buffer: AudioBuffer, options?: any) {
    const onProgress = options?.onProgress

    const rawStems = await separateWithDemucsRs(buffer, {
      model: this.model,
      onProgress: (info) => onProgress?.(info.progress, info.message || info.phase),
      signal: options?.signal,
    })

    const stems = rawStems.map(s => ({
      name: s.name,
      audioBuffer: s.buffer,
      duration: s.buffer.duration,
    }))

    return {
      stems,
      sourceDuration: buffer.duration,
      modelUsed: this.getName(),
      processedAt: Date.now(),
      processingTimeMs: 0,
    }
  }

  dispose() {}
}

let engineInstance: StemEngine | null = null

/**
 * The single engine for weblooper stem separation.
 * 6-stem (guitar + piano) via demucs-rs is now the only path.
 */
export async function createBestStemEngine(): Promise<StemEngine | null> {
  if (engineInstance) return engineInstance

  if (await isDemucsRsSupported()) {
    console.log('[stems] Using demucs-rs 6-stem (guitar + piano) — only engine')
    engineInstance = new DemucsRsEngine('htdemucs_6s')
    return engineInstance
  }

  console.warn('[stems] demucs-rs 6-stem not supported in this browser (needs WebGPU + SharedArrayBuffer)')
  return null
}

/**
 * Quick synchronous check for the minimal requirements before we even try loading models.
 * This lets us show a friendly "your browser/device isn't ready yet" message early.
 */
export function hasMinimumBrowserCapabilities(): boolean {
  const hasSharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined'
  const hasWebWorker = typeof Worker !== 'undefined'
  const hasWebAssembly = typeof WebAssembly !== 'undefined'

  return hasSharedArrayBuffer && hasWebWorker && hasWebAssembly
}
