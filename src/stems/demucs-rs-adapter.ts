/**
 * demucs-rs Adapter — THE ONLY stem separation engine in weblooper.
 *
 * 6-stem model (htdemucs_6s): drums, bass, guitar, piano, vocals, other.
 * Powered by the excellent Rust implementation compiled to WASM + WebGPU.
 *
 * https://github.com/nikhilunni/demucs-rs
 */

import type { StemTrack } from './stem-player'

export type DemucsRsModel = 'htdemucs' | 'htdemucs_6s' | 'htdemucs_ft'

export interface DemucsRsProgress {
  phase: 'download' | 'processing'
  progress: number
  message?: string
}

export interface DemucsRsSeparateOptions {
  model?: DemucsRsModel
  onProgress?: (info: DemucsRsProgress) => void
  signal?: AbortSignal
}

const WORKER_URL = new URL('./workers/demucs-rs-worker.ts', import.meta.url)

// WASM assets now live inside src/vendor/demucs-rs/
// They are resolved inside the worker using new URL(..., import.meta.url) for proper Vite support.

let worker: Worker | null = null
let readyPromise: Promise<void> | null = null

function createWorker(): Worker {
  return new Worker(WORKER_URL, { type: 'module' })
}

async function ensureWorker(onProgress?: (p: DemucsRsProgress) => void): Promise<Worker> {
  if (worker && readyPromise) {
    await readyPromise
    return worker
  }

  worker = createWorker()

  readyPromise = new Promise((resolve, reject) => {
    const onMsg = (ev: MessageEvent) => {
      const m = ev.data
      if (m.type === 'progress' && onProgress) onProgress(m)
      if (m.type === 'ready') {
        worker!.removeEventListener('message', onMsg)
        resolve()
      }
      if (m.type === 'error') {
        worker!.removeEventListener('message', onMsg)
        reject(new Error(m.error))
      }
    }
    worker!.addEventListener('message', onMsg)

    worker!.postMessage({ type: 'init' })
  })

  await readyPromise

  return worker
}

export async function separateWithDemucsRs(
  audioBuffer: AudioBuffer,
  options: DemucsRsSeparateOptions = {}
): Promise<StemTrack[]> {
  const onProgress = options.onProgress

  onProgress?.({ phase: 'download', progress: 0, message: 'Starting demucs-rs 6-stem worker...' })

  const w = await ensureWorker(onProgress)

  // Convert to 44.1 kHz stereo Float32 (standard for this model)
  const { left, right } = await resampleTo44100Stereo(audioBuffer)

  onProgress?.({ phase: 'processing', progress: 0.1, message: 'Running 6-stem inference (WebGPU)...' })

  return new Promise((resolve, reject) => {
    // The 6-stem model is very heavy. On slower GPUs / Safari WebGPU, it can easily
    // take 15-40+ minutes for a 3-5 minute song. Use a very generous timeout.
    const timeoutMs = Math.max(30 * 60 * 1000, audioBuffer.duration * 8 * 60 * 1000)
    const timeout = setTimeout(() => {
      reject(new Error(
        `Separation timed out after ${Math.round(timeoutMs / 60000)} minutes. ` +
        `This model is extremely demanding. Try a shorter file, a stronger GPU, or Chrome (often faster for this workload than Safari).`
      ))
    }, timeoutMs)

    const handler = (ev: MessageEvent) => {
      const m = ev.data
      if (m.type === 'progress' && onProgress) onProgress(m)

      if (m.type === 'result') {
        clearTimeout(timeout)
        w.removeEventListener('message', handler)

        const stems: StemTrack[] = (m.stems || []).map((s: any) => ({
          name: s.name,
          buffer: float32PairToAudioBuffer(s.left, s.right, 44100),
        }))
        resolve(stems)
      }
      if (m.type === 'error') {
        clearTimeout(timeout)
        w.removeEventListener('message', handler)

        // Preserve extra diagnostic info from the worker when available
        const rich = m.error || 'Unknown worker error'
        const extra = m.stack ? `\n${m.stack}` : (m.details ? `\nDetails: ${JSON.stringify(m.details)}` : '')
        reject(new Error(String(rich) + extra))
      }
    }

    w.addEventListener('message', handler)

    w.postMessage({
      type: 'separate',
      audio: { left, right },
    })
  })
}

async function resampleTo44100Stereo(buffer: AudioBuffer): Promise<{ left: Float32Array; right: Float32Array }> {
  const targetRate = 44100
  if (buffer.sampleRate === targetRate) {
    const l = buffer.getChannelData(0)
    const r = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : l
    return { left: new Float32Array(l), right: new Float32Array(r) }
  }

  const offline = new OfflineAudioContext(2, Math.ceil(buffer.duration * targetRate), targetRate)
  const src = offline.createBufferSource()
  src.buffer = buffer
  src.connect(offline.destination)
  src.start()
  const rendered = await offline.startRendering()
  return {
    left: new Float32Array(rendered.getChannelData(0)),
    right: new Float32Array(rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : rendered.getChannelData(0)),
  }
}

function float32PairToAudioBuffer(left: Float32Array, right: Float32Array, sr: number): AudioBuffer {
  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: sr })
  const len = Math.max(left.length, right.length)
  const b = ctx.createBuffer(2, len, sr)
  b.copyToChannel(new Float32Array(left), 0)
  b.copyToChannel(new Float32Array(right), 1)
  return b
}

export async function isDemucsRsSupported(): Promise<boolean> {
  // demucs-rs is single-threaded and uses WebGPU compute shaders for acceleration.
  // It does NOT require SharedArrayBuffer or cross-origin isolation.
  // Only WebAssembly + WebGPU are needed.
  if (typeof WebAssembly === 'undefined') return false

  try {
    if ('gpu' in navigator) {
      const adapter = await (navigator as any).gpu.requestAdapter?.()
      return !!adapter
    }
  } catch {}
  return false
}

export function getDemucsRsModelLabel(_model: DemucsRsModel): string {
  return 'drums, bass, guitar, piano, vocals, other'
}

export function getDemucsRsModelUrl(model: DemucsRsModel): string {
  const name = model === 'htdemucs_6s' ? 'htdemucs_6s' : model === 'htdemucs_ft' ? 'htdemucs_ft' : 'htdemucs'
  // Models are hosted under set-soft/audio_separation (the location referenced by demucs-rs itself)
  return `https://huggingface.co/set-soft/audio_separation/resolve/main/Demucs/${name}.safetensors`
}