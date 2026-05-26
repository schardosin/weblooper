/**
 * Real stem separation adapter using `demucs-web` + ONNX Runtime Web.
 *
 * This is the first working path to genuine AI-powered stem separation
 * running entirely in the user's browser.
 *
 * Model: HTDemucs (4 stems: drums, bass, other, vocals)
 * Size: ~172 MB (downloaded once, cached by browser)
 */

import type { StemTrack } from './stem-player'

let cachedProcessor: any = null
// let cachedOrt: any = null  // reserved for future advanced use

export interface SeparationProgress {
  phase: 'download' | 'processing'
  progress: number // 0-1
  message?: string
}

export interface SeparateOptions {
  onProgress?: (info: SeparationProgress) => void
  signal?: AbortSignal
}

/**
 * Loads (or returns cached) DemucsProcessor + ort.
 * This triggers the ~172MB model download on first use.
 */
export async function getDemucsProcessor(onProgress?: (info: SeparationProgress) => void): Promise<any> {
  if (cachedProcessor) return cachedProcessor

  // Dynamic imports so the heavy packages are only loaded when user actually wants stems
  const [{ DemucsProcessor, CONSTANTS }, ortModule] = await Promise.all([
    import('demucs-web'),
    import('onnxruntime-web'),
  ])

  const ort = (ortModule as any).default || ortModule

  // Recommended ONNX tuning
  ort.env.wasm.numThreads = Math.min(navigator.hardwareConcurrency || 4, 8)

  // Prefer WebGPU when available
  let executionProviders: string[] = ['wasm']
  try {
    if ('gpu' in navigator) {
      const adapter = await (navigator as any).gpu.requestAdapter?.()
      if (adapter) {
        executionProviders = ['webgpu', 'wasm']
        ort.env.webgpu = { powerPreference: 'high-performance' }
      }
    }
  } catch {
    // WebGPU not available or blocked
  }

  const processor = new DemucsProcessor({
    ort,
    onProgress: ({ progress, currentSegment, totalSegments }: any) => {
      onProgress?.({
        phase: 'processing',
        progress,
        message: `Segment ${currentSegment}/${totalSegments}`,
      })
    },
    onDownloadProgress: (loaded: number, total: number) => {
      onProgress?.({
        phase: 'download',
        progress: total > 0 ? loaded / total : 0,
        message: `Downloading model ${(loaded / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB`,
      })
    },
    sessionOptions: {
      executionProviders,
      enableCpuMemArena: false,
      enableMemPattern: false,
    },
  })

  // Load the model (this is the heavy part)
  const modelUrl = (CONSTANTS as any).DEFAULT_MODEL_URL ||
    'https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx'

  await processor.loadModel(modelUrl)

  cachedProcessor = processor
  return processor
}

/**
 * Performs real stem separation on an AudioBuffer and returns
 * ready-to-use StemTrack[] objects for the StemPlayer.
 */
export async function separateToStemTracks(
  audioBuffer: AudioBuffer,
  options: SeparateOptions = {}
): Promise<StemTrack[]> {
  const { onProgress } = options

  const processor = await getDemucsProcessor(onProgress)

  // Get left/right at (ideally) 44100 Hz
  const targetSampleRate = 44100

  let left: Float32Array
  let right: Float32Array

  if (audioBuffer.sampleRate === targetSampleRate) {
    left = audioBuffer.getChannelData(0)
    right = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : left
  } else {
    // Simple resample using OfflineAudioContext (good enough for v1)
    const offline = new OfflineAudioContext(
      2,
      Math.ceil(audioBuffer.duration * targetSampleRate),
      targetSampleRate
    )
    const source = offline.createBufferSource()
    source.buffer = audioBuffer
    source.connect(offline.destination)
    source.start()

    const rendered = await offline.startRendering()
    left = rendered.getChannelData(0)
    right = rendered.getChannelData(1)
  }

  // Run the actual separation
  const result = await processor.separate(left, right)

  // Convert Float32 results back to AudioBuffers (mono for simplicity & memory)
  const makeAudioBuffer = (floatData: Float32Array): AudioBuffer => {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: targetSampleRate })
    const buf = ctx.createBuffer(1, floatData.length, targetSampleRate)
    buf.copyToChannel(new Float32Array(floatData), 0)
    // We don't close ctx here — it's cheap and the buffer lives on
    return buf
  }

  const stems: Array<{ name: string; buffer: AudioBuffer }> = [
    { name: 'Drums', buffer: makeAudioBuffer(result.drums.left) },
    { name: 'Bass', buffer: makeAudioBuffer(result.bass.left) },
    { name: 'Other', buffer: makeAudioBuffer(result.other.left) },
    { name: 'Vocals', buffer: makeAudioBuffer(result.vocals.left) },
  ]

  return stems
}

/**
 * Quick capability check specific to this backend.
 */
export async function isDemucsWebSupported(): Promise<boolean> {
  const hasSAB = typeof SharedArrayBuffer !== 'undefined'
  const hasWasm = typeof WebAssembly !== 'undefined'
  return hasSAB && hasWasm
}
