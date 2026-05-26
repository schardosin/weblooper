/**
 * Audio decoding helpers for weblooper stem separation path.
 *
 * All decoding happens client-side using the Web Audio API.
 * No server round-trips.
 */

export interface DecodedAudio {
  buffer: AudioBuffer
  duration: number
  sampleRate: number
  numberOfChannels: number
  fileName: string
}

/**
 * Decode a File (from <input type="file"> or drag-and-drop) into an AudioBuffer.
 * Uses OfflineAudioContext for reliable decoding even for longer files.
 */
export async function decodeAudioFile(file: File): Promise<DecodedAudio> {
  const arrayBuffer = await file.arrayBuffer()
  return decodeAudioBuffer(arrayBuffer, file.name)
}

/**
 * Decode a raw ArrayBuffer into an AudioBuffer.
 * Useful for audio downloaded from YouTube or other sources.
 */
export async function decodeAudioBuffer(arrayBuffer: ArrayBuffer, fileName = 'audio'): Promise<DecodedAudio> {
  // Create a fresh AudioContext (or reuse a singleton later)
  const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()

  let audioBuffer: AudioBuffer
  try {
    // Preferred modern API (returns Promise)
    audioBuffer = await audioContext.decodeAudioData(arrayBuffer)
  } catch (err) {
    // Some older browsers / edge cases need the callback form
    audioBuffer = await new Promise<AudioBuffer>((resolve, reject) => {
      audioContext.decodeAudioData(
        arrayBuffer,
        (buffer) => resolve(buffer),
        (error) => reject(error)
      )
    })
  }

  // Best-effort: close the context if the browser allows it (not critical)
  try {
    await audioContext.close?.()
  } catch {
    // ignore
  }

  return {
    buffer: audioBuffer,
    duration: audioBuffer.duration,
    sampleRate: audioBuffer.sampleRate,
    numberOfChannels: audioBuffer.numberOfChannels,
    fileName,
  }
}

/**
 * Very rough human-friendly estimate of separation time on a "typical" 2026 machine.
 * This will be replaced by real measurements from the StemEngine once wired.
 */
export function estimateSeparationMinutes(durationSeconds: number): number {
  // Very crude heuristic: ~0.8–1.2× realtime on a good GPU for HTDemucs-style models in browser.
  // Adjust once we have real benchmarks from demucs-rs adapter.
  const factor = 1.0
  return Math.max(0.5, Math.round((durationSeconds * factor) / 60))
}
