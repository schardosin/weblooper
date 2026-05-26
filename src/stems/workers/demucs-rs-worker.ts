/**
 * Web Worker for demucs-rs 6-stem (drums, bass, guitar, piano, vocals, other).
 * Heavy lifting (WASM + WebGPU inference) happens here.
 */

let wasmGlue: any = null
let modelCache: Map<string, Uint8Array> = new Map()

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data

  try {
    if (msg.type === 'init') {
      await initWasm()
      self.postMessage({ type: 'ready' })
      return
    }

    if (msg.type === 'separate') {
      if (!wasmGlue) throw new Error('WASM not initialized')

      const { left, right } = msg.audio
      const sampleRate = msg.sampleRate || 44100
      const modelId = 'htdemucs_6s'
      const selectedStems = ['drums', 'bass', 'guitar', 'piano', 'vocals', 'other']

      self.postMessage({ type: 'progress', phase: 'processing', progress: 0.1, message: 'Loading model weights...' })

      // Get or download model bytes (with optional HF token support)
      let modelBytes = modelCache.get(modelId)
      if (!modelBytes) {
        // Source of truth for the 6-stem weights: the demucs-rs project itself points here
        // (see demucs-core/src/model/metadata.rs → HF_BASE_URL + HTDEMUCS_6S.filename)
        const modelUrl = 'https://huggingface.co/set-soft/audio_separation/resolve/main/Demucs/htdemucs_6s.safetensors?download=true'

        const resp = await fetch(modelUrl)
        if (!resp.ok) {
          throw new Error(`Failed to download model: ${resp.status} ${resp.statusText}`)
        }
        const buf = await resp.arrayBuffer()
        modelBytes = new Uint8Array(buf)
        modelCache.set(modelId, modelBytes)

        self.postMessage({
          type: 'progress',
          phase: 'processing',
          progress: 0.15,
          message: `Downloaded ${(modelBytes.length / 1024 / 1024).toFixed(1)} MB weights. Validating...`
        })

        // Critical diagnostic: does this safetensors file have the tensor key prefixes
        // that this WASM build (and the demucs-rs Burn port) expects?
        // The 6-stem model requires keys starting with "5c90dfd2." (see metadata.rs).
        if (typeof wasmGlue.validate_model_weights === 'function') {
          const validation = wasmGlue.validate_model_weights(modelBytes, modelId)
          console.log('[demucs-rs-worker] validate_model_weights result:', validation)

          if (validation && validation.valid === false) {
            throw new Error(
              `Model weights are incompatible: ${validation.error || 'unknown validation failure'}. ` +
              `This WASM build expects tensor keys with a specific prefix for ${modelId}. ` +
              `The file from Hugging Face may be a different conversion of the weights.`
            )
          }

          const counts = validation?.tensor_counts ? ` (${validation.tensor_counts.join(', ')} tensors per signature)` : ''
          self.postMessage({
            type: 'progress',
            phase: 'processing',
            progress: 0.18,
            message: `Weights validated${counts}. Loading into WebGPU...`
          })
        } else {
          console.warn('[demucs-rs-worker] validate_model_weights not exported by this WASM build')
        }
      }

      self.postMessage({
        type: 'progress',
        phase: 'processing',
        progress: 0.22,
        message: 'Starting 6-stem inference on WebGPU (longest step — model progress updates are often limited)'
      })

      // Dedup + rate limit progress messages coming from the WASM.
      // Many demucs-rs WASM builds call the callback very frequently with no actual progress value.
      let lastPostedP = 0.22
      let lastPostedTime = 0
      const MIN_PROGRESS_DELTA = 0.015   // only forward if we moved at least ~1.5%
      const MIN_TIME_BETWEEN_HEARTBEATS = 4500 // ms

      const result = await wasmGlue.separate(
        modelBytes,
        modelId,
        selectedStems,
        left,
        right,
        sampleRate,
        (progressEvent: any) => {
          const now = Date.now()

          // The demucs-rs WASM may call this callback with different shapes.
          let p = 0
          let msg = ''

          if (progressEvent) {
            if (typeof progressEvent.progress === 'number') {
              p = Math.max(0, Math.min(1, progressEvent.progress))
            } else if (typeof progressEvent === 'number') {
              p = Math.max(0, Math.min(1, progressEvent))
            }
            msg = progressEvent.message || progressEvent.status || ''
          }

          const computedP = 0.22 + p * 0.68

          // Decide whether this update is worth forwarding
          const progressMovedEnough = (computedP - lastPostedP) >= MIN_PROGRESS_DELTA
          const enoughTimePassed = (now - lastPostedTime) >= MIN_TIME_BETWEEN_HEARTBEATS
          const hasUsefulMessage = msg && msg !== 'Inference running on GPU...'

          const shouldPost =
            progressMovedEnough ||
            (hasUsefulMessage && enoughTimePassed) ||
            (p === 0 && msg && enoughTimePassed && computedP > lastPostedP + 0.005)

          if (shouldPost) {
            const finalMsg = msg || (p > 0 ? `Inference ${Math.round(p * 100)}%` : 'Inference running on GPU...')
            self.postMessage({
              type: 'progress',
              phase: 'processing',
              progress: computedP,
              message: finalMsg
            })
            lastPostedP = computedP
            lastPostedTime = now
          } else if (p === 0 && !msg && enoughTimePassed) {
            // Absolute last resort heartbeat so the UI knows we are still alive,
            // but only very rarely.
            self.postMessage({
              type: 'progress',
              phase: 'processing',
              progress: lastPostedP,
              message: 'Inference running on GPU...'
            })
            lastPostedTime = now
          }
        }
      )

      // Convert SeparationResult to per-stem left/right arrays.
      // IMPORTANT: n_samples, num_stems and stem_names() must be read BEFORE
      // take_audio(), because take_audio() consumes the result (calls
      // __destroy_into_raw which sets __wbg_ptr = 0). Accessing any getter
      // after that causes "null pointer passed to rust".
      const nSamples = result.n_samples
      const numStems = result.num_stems
      const stemNames = result.stem_names()
      const flatAudio = result.take_audio() as Float32Array

      const stems: Array<{ name: string; left: Float32Array; right: Float32Array }> = []

      for (let i = 0; i < numStems; i++) {
        const name = stemNames[i] || `stem${i}`
        const offset = i * 2 * nSamples
        const stemLeft = flatAudio.subarray(offset, offset + nSamples)
        const stemRight = flatAudio.subarray(offset + nSamples, offset + 2 * nSamples)
        stems.push({
          name,
          left: new Float32Array(stemLeft),
          right: new Float32Array(stemRight),
        })
      }

      self.postMessage({ type: 'result', stems })
    }
  } catch (err: any) {
    // Send as much detail as possible back to the main thread.
    // "null pointer passed to rust" usually means a bad input slice reached the WASM boundary
    // or a panic inside Rust that the console_error_panic_hook should have also printed.
    console.error('[demucs-rs-worker] Separation error:', err)
    self.postMessage({
      type: 'error',
      error: err?.message || String(err),
      stack: err?.stack || null,
      // If the error object itself has extra fields from wasm-bindgen, include them
      details: typeof err === 'object' ? { ...err } : null
    })
  }
}

async function initWasm() {
  // Architecturally correct way in Vite:
  // Assets live inside src/ → we resolve them with new URL(..., import.meta.url)
  // This works in dev, build, and inside Web Workers.
  const glueUrl = new URL('../../vendor/demucs-rs/demucs_wasm.js', import.meta.url).href
  const wasmBinaryUrl = new URL('../../vendor/demucs-rs/demucs_wasm_bg.wasm', import.meta.url).href

  // @ts-ignore - dynamic import of wasm-pack output
  const glue = await import(/* @vite-ignore */ glueUrl)

  // Standard wasm-pack initialization for web target
  if (typeof glue.default === 'function') {
    await glue.default(wasmBinaryUrl)
  }

  wasmGlue = glue
  console.log('[demucs-rs-worker] demucs-rs WASM loaded via proper Vite asset resolution')

  // Log what models this particular WASM build was compiled to support
  try {
    const registry = glue.get_model_registry?.()
    console.log('[demucs-rs-worker] Model registry from WASM:', registry)
  } catch (e) {
    console.warn('[demucs-rs-worker] Could not read model registry:', e)
  }
}

// Worker global
declare const self: any
export {}