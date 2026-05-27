/**
 * Stem separation types for weblooper.
 * Designed for fully client-side (browser) processing using WASM + WebGPU.
 *
 * Core vision: The website is "in the cloud", but all heavy ML inference
 * runs on the *visitor's own device*. Zero marginal compute cost to the operator.
 */

/**
 * Stem names we care about for 6-stem (htdemucs_6s) and future models.
 * Using string for flexibility (new models may add more).
 */
export type StemName = string

export interface Stem {
  name: string
  audioBuffer: AudioBuffer
  duration?: number
}

/** Canonical 6-stem order from htdemucs_6s (demucs-rs and official) */
export const SIX_STEM_ORDER = ['drums', 'bass', 'guitar', 'piano', 'vocals', 'other'] as const

export type SixStemName = (typeof SIX_STEM_ORDER)[number]


export interface SeparationResult {
  stems: Stem[]
  sourceDuration: number
  modelUsed: string
  processedAt: number // timestamp
  processingTimeMs: number
}

export interface StemEngineOptions {
  /** Preferred model variant. "htdemucs-4s" | "htdemucs-6s" etc. */
  model?: string
  /** Callback for progress (0-1). Called frequently during separation. */
  onProgress?: (progress: number, stage: string) => void
  /** Allow cancellation via AbortSignal. */
  signal?: AbortSignal
}

export interface StemEngine {
  /**
   * Returns true if this engine can run in the current browser environment
   * (WebGPU available, enough memory, SharedArrayBuffer supported, etc.).
   */
  isSupported(): Promise<boolean>

  /**
   * Human-friendly name + version of the underlying model/engine.
   */
  getName(): string

  /**
   * Estimate processing time for a given audio duration (in seconds).
   * Used for UX ("~4 minutes on this device").
   */
  estimateProcessingTime(audioDurationSec: number): Promise<number>

  /**
   * Perform stem separation on the provided AudioBuffer.
   * All heavy work must happen off the main thread (Worker + WASM).
   */
  separate(buffer: AudioBuffer, options?: StemEngineOptions): Promise<SeparationResult>

  /**
   * Optional: Preload model weights into memory / cache.
   * Call this early (e.g. on user intent) to reduce perceived latency.
   */
  preload?(): Promise<void>

  /**
   * Free resources (WASM memory, workers, etc.).
   */
  dispose(): void
}

/**
 * Metadata stored alongside a processed song (in OPFS or IndexedDB).
 */
export interface ProcessedAudioMeta {
  id: string // content hash or user-provided name + timestamp
  originalName: string
  duration: number
  stemCount: number
  model: string
  createdAt: number
}

/**
 * A user-saved loop preset (used in both video and stem practice views).
 */
export interface LoopPreset {
  id: string
  name: string
  start: number
  end: number
}
