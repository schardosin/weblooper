/**
 * Tab Audio Capture — Pure client-side YouTube audio extraction.
 *
 * Uses the Web Audio API + getDisplayMedia({ audio: true }) to capture
 * the audio output from the current browser tab. This works on GitHub Pages
 * without any backend/proxy.
 *
 * Flow:
 * 1. User clicks "Separate Stems" on a YouTube video
 * 2. Browser shows "Share tab" dialog (preferCurrentTab streamlines this)
 * 3. onPermissionGranted fires — caller starts video playback
 * 4. Video plays at normal speed while we record the audio
 * 5. Recording completes → clean AudioBuffer → stem separation
 */

export interface CaptureProgress {
  phase: 'permission' | 'recording' | 'processing' | 'complete'
  message: string
  percent?: number
  /** Elapsed wall-clock seconds since recording started */
  elapsed?: number
  /** Expected duration of the recording in seconds */
  estimatedDuration?: number
}

export interface CaptureOptions {
  /** Expected duration of the video in seconds */
  durationSeconds: number
  /** Abort signal to cancel the capture */
  signal?: AbortSignal
  /** Progress callback */
  onProgress?: (info: CaptureProgress) => void
  /**
   * Called after tab sharing permission is granted and recording is ready to begin.
   * Use this to start video playback — the recording will capture from this point.
   * This ensures no audio is missed while the permission dialog was shown.
   */
  onPermissionGranted?: () => void | Promise<void>
}

export interface CaptureResult {
  /** The captured audio buffer (clean, unprocessed) */
  buffer: AudioBuffer
  /** Actual capture duration in wall-clock seconds */
  captureDuration: number
}

/**
 * Check if tab audio capture is supported in this browser.
 * Requires getDisplayMedia with audio support (Chrome 94+, Edge 94+).
 */
export function isTabAudioCaptureSupported(): boolean {
  return !!(
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getDisplayMedia === 'function'
  )
}

/**
 * Capture audio from the current tab for the specified duration.
 *
 * Flow:
 * 1. Requests tab sharing permission (getDisplayMedia)
 * 2. Once granted, calls onPermissionGranted so caller can start playback
 * 3. Records audio via Web Audio API
 * 4. Auto-stops when duration is reached or user aborts
 *
 * Returns a clean AudioBuffer at 44100 Hz ready for stem separation.
 */
export async function captureTabAudio(options: CaptureOptions): Promise<CaptureResult> {
  const { durationSeconds, signal, onProgress } = options

  onProgress?.({
    phase: 'permission',
    message: 'Requesting tab audio access...',
  })

  // Request tab capture with audio
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      audio: {
        // Request high quality audio capture
        autoGainControl: false,
        echoCancellation: false,
        noiseSuppression: false,
      } as any,
      video: true, // Required by spec even though we only want audio
      // @ts-ignore - preferCurrentTab is Chrome 94+
      preferCurrentTab: true,
      // @ts-ignore - selfBrowserSurface is Chrome 107+
      selfBrowserSurface: 'include',
    } as any)
  } catch (err: any) {
    if (err.name === 'NotAllowedError') {
      throw new Error(
        'Tab sharing was denied. To capture YouTube audio:\n' +
        '1. Click "Separate Stems" again\n' +
        '2. In the dialog, select THIS tab\n' +
        '3. Make sure "Share tab audio" is checked\n' +
        '4. Click "Share"'
      )
    }
    throw new Error(`Tab audio capture failed: ${err.message}`)
  }

  // Check that we actually got an audio track
  const audioTracks = stream.getAudioTracks()
  if (audioTracks.length === 0) {
    stream.getTracks().forEach(t => t.stop())
    throw new Error(
      'No audio track was captured. Make sure "Share tab audio" is checked in the sharing dialog.'
    )
  }

  // Stop the video track immediately (we only need audio)
  stream.getVideoTracks().forEach(t => t.stop())

  // Permission granted and audio stream ready — notify caller to start playback
  if (options.onPermissionGranted) {
    await options.onPermissionGranted()
  }

  onProgress?.({
    phase: 'recording',
    message: formatRecordingMessage(0, durationSeconds),
    percent: 0,
    elapsed: 0,
    estimatedDuration: durationSeconds,
  })

  // Set up Web Audio API to record the stream
  const sampleRate = 44100
  const audioContext = new AudioContext({ sampleRate })
  const source = audioContext.createMediaStreamSource(
    new MediaStream(audioTracks)
  )

  // Use ScriptProcessorNode for recording (deprecated but universally supported)
  // Routed through a zero-gain node so user doesn't hear double audio
  const bufferSize = 4096
  const processor = audioContext.createScriptProcessor(bufferSize, 2, 2)

  const leftChunks: Float32Array[] = []
  const rightChunks: Float32Array[] = []
  let totalSamples = 0
  const startTime = Date.now()

  return new Promise<CaptureResult>((resolve, reject) => {
    let finished = false

    // Handle abort (user clicks "Stop" or "Cancel")
    const abortHandler = () => {
      if (!finished) {
        finished = true
        cleanup()
        // If we have some recorded audio, resolve with what we have
        if (totalSamples > sampleRate) {
          buildResult().then(resolve).catch(reject)
        } else {
          reject(new Error('Audio capture was cancelled'))
        }
      }
    }

    if (signal) {
      signal.addEventListener('abort', abortHandler, { once: true })
    }

    const cleanup = () => {
      try { processor.disconnect() } catch {}
      try { source.disconnect() } catch {}
      try { gain.disconnect() } catch {}
      audioTracks.forEach(t => t.stop())
      audioContext.close().catch(() => {})
      if (signal) signal.removeEventListener('abort', abortHandler)
    }

    // Auto-stop after the expected duration + 3s buffer
    const maxDurationMs = (durationSeconds + 3) * 1000
    const autoStopTimeout = setTimeout(() => {
      if (!finished) {
        finished = true
        cleanup()
        buildResult().then(resolve).catch(reject)
      }
    }, maxDurationMs)

    // Also watch for the audio track ending (user stops sharing)
    audioTracks[0].addEventListener('ended', () => {
      if (!finished) {
        finished = true
        clearTimeout(autoStopTimeout)
        cleanup()
        if (totalSamples > sampleRate) {
          buildResult().then(resolve).catch(reject)
        } else {
          reject(new Error('Tab sharing ended before any audio was captured.'))
        }
      }
    })

    async function buildResult(): Promise<CaptureResult> {
      if (totalSamples === 0) {
        throw new Error('No audio was captured. Make sure the video was playing.')
      }

      onProgress?.({
        phase: 'processing',
        message: 'Processing captured audio...',
        percent: 95,
      })

      // Assemble captured chunks into an AudioBuffer
      const rawBuffer = new AudioBuffer({
        length: totalSamples,
        numberOfChannels: 2,
        sampleRate,
      })

      let offset = 0
      const leftChannel = rawBuffer.getChannelData(0)
      const rightChannel = rawBuffer.getChannelData(1)

      for (let i = 0; i < leftChunks.length; i++) {
        leftChannel.set(leftChunks[i], offset)
        rightChannel.set(rightChunks[i], offset)
        offset += leftChunks[i].length
      }

      // Trim excess from the beginning: the recording starts before the video plays,
      // but ends precisely when the video finishes. So all excess is at the start.
      // We keep exactly `durationSeconds` from the end of the buffer.
      const excess = rawBuffer.duration - durationSeconds
      let buffer = rawBuffer
      if (excess > 0.05) {
        const trimSamples = Math.round(excess * sampleRate)
        const trimmedLength = totalSamples - trimSamples
        if (trimmedLength > 0) {
          buffer = new AudioBuffer({
            length: trimmedLength,
            numberOfChannels: 2,
            sampleRate,
          })
          buffer.getChannelData(0).set(leftChannel.subarray(trimSamples))
          buffer.getChannelData(1).set(rightChannel.subarray(trimSamples))
          console.log(`[tab-audio-capture] Trimmed ${excess.toFixed(3)}s (${trimSamples} samples) from start to align with video`)
        }
      }

      const captureDuration = (Date.now() - startTime) / 1000

      onProgress?.({
        phase: 'complete',
        message: 'Audio capture complete',
        percent: 100,
      })

      return { buffer, captureDuration }
    }

    // Zero-gain output so user doesn't hear double audio from the processor
    const gain = audioContext.createGain()
    gain.gain.value = 0
    source.connect(processor)
    processor.connect(gain)
    gain.connect(audioContext.destination)

    // Capture audio samples
    processor.onaudioprocess = (event) => {
      if (finished) return

      const left = event.inputBuffer.getChannelData(0)
      const right = event.inputBuffer.numberOfChannels > 1
        ? event.inputBuffer.getChannelData(1)
        : left

      leftChunks.push(new Float32Array(left))
      rightChunks.push(new Float32Array(right))
      totalSamples += left.length

      // Report progress based on wall-clock time vs expected duration
      const elapsed = (Date.now() - startTime) / 1000
      const percent = Math.min(90, (elapsed / durationSeconds) * 90)

      onProgress?.({
        phase: 'recording',
        message: formatRecordingMessage(elapsed, durationSeconds),
        percent,
        elapsed,
        estimatedDuration: durationSeconds,
      })
    }
  })
}

/**
 * Format a human-readable recording progress message.
 */
function formatRecordingMessage(elapsed: number, estimated: number): string {
  const remaining = Math.max(0, estimated - elapsed)
  const elapsedStr = formatTime(elapsed)
  const remainingStr = formatTime(remaining)
  return `Recording... ${elapsedStr} elapsed, ~${remainingStr} remaining`
}

/**
 * Format seconds as m:ss
 */
function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}
