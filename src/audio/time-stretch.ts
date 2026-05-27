/**
 * Time-stretching utility using SoundTouch.js
 *
 * Changes playback speed without changing pitch (WSOLA algorithm).
 * Used by the StemPlayer to provide pitch-preserved tempo control.
 */

import { SoundTouch, SimpleFilter } from 'soundtouchjs'

/**
 * Source adapter that provides interleaved stereo samples to SoundTouch.
 */
class AudioBufferSource {
  private buffer: AudioBuffer
  position: number = 0

  constructor(buffer: AudioBuffer) {
    this.buffer = buffer
  }

  extract(target: Float32Array, numFrames: number, position: number): number {
    this.position = position
    const left = this.buffer.getChannelData(0)
    const right = this.buffer.numberOfChannels > 1
      ? this.buffer.getChannelData(1)
      : left

    const available = Math.min(numFrames, this.buffer.length - position)
    if (available <= 0) return 0

    // Interleave L/R into target (SoundTouch expects interleaved stereo)
    for (let i = 0; i < available; i++) {
      target[i * 2] = left[position + i]
      target[i * 2 + 1] = right[position + i]
    }

    return available
  }
}

/**
 * Time-stretch an AudioBuffer to a new tempo without changing pitch.
 *
 * @param buffer   The source AudioBuffer
 * @param tempo    The tempo multiplier (e.g. 0.75 = 75% speed, 1.5 = 150% speed)
 * @returns        A new AudioBuffer at the adjusted tempo
 */
export function timeStretch(buffer: AudioBuffer, tempo: number): AudioBuffer {
  if (Math.abs(tempo - 1.0) < 0.01) {
    // No stretching needed
    return buffer
  }

  const sampleRate = buffer.sampleRate
  const numChannels = Math.min(buffer.numberOfChannels, 2) // SoundTouch handles stereo
  const originalLength = buffer.length

  // Expected output length (approximate — SoundTouch may produce slightly more/less)
  const expectedLength = Math.ceil(originalLength / tempo)

  // Set up SoundTouch
  const st = new SoundTouch()
  st.tempo = tempo
  // Keep pitch at 1.0 (no pitch shift)
  st.pitch = 1.0

  // Source adapter
  const source = new AudioBufferSource(buffer)

  // SimpleFilter processes audio through SoundTouch
  const filter = new SimpleFilter(source, st)

  // Extract all processed samples
  // Process in chunks to avoid huge single allocations
  const CHUNK_SIZE = 8192
  const outputChunks: Float32Array[] = []
  let totalFrames = 0

  while (true) {
    const chunk = new Float32Array(CHUNK_SIZE * 2) // interleaved stereo
    const framesExtracted = filter.extract(chunk, CHUNK_SIZE)

    if (framesExtracted === 0) break

    if (framesExtracted < CHUNK_SIZE) {
      // Last partial chunk
      outputChunks.push(chunk.subarray(0, framesExtracted * 2))
    } else {
      outputChunks.push(chunk)
    }
    totalFrames += framesExtracted

    // Safety: don't exceed 3x expected length (prevents infinite loops)
    if (totalFrames > expectedLength * 3) break
  }

  // Assemble output into an AudioBuffer
  const outputLength = totalFrames
  const ctx = new OfflineAudioContext(numChannels, outputLength, sampleRate)
  const outputBuffer = ctx.createBuffer(numChannels, outputLength, sampleRate)

  const leftOut = outputBuffer.getChannelData(0)
  const rightOut = numChannels > 1 ? outputBuffer.getChannelData(1) : null

  let writeOffset = 0
  for (const chunk of outputChunks) {
    const frames = chunk.length / 2
    for (let i = 0; i < frames; i++) {
      leftOut[writeOffset + i] = chunk[i * 2]
      if (rightOut) {
        rightOut[writeOffset + i] = chunk[i * 2 + 1]
      }
    }
    writeOffset += frames
  }

  return outputBuffer
}

/**
 * Time-stretch multiple AudioBuffers in parallel (for all stems).
 * Processes sequentially to avoid blocking the main thread too badly,
 * yielding between stems.
 */
export async function timeStretchStems(
  stems: Array<{ name: string; buffer: AudioBuffer }>,
  tempo: number,
  onProgress?: (stemIndex: number, totalStems: number) => void,
): Promise<Array<{ name: string; buffer: AudioBuffer }>> {
  if (Math.abs(tempo - 1.0) < 0.01) {
    return stems
  }

  const results: Array<{ name: string; buffer: AudioBuffer }> = []

  for (let i = 0; i < stems.length; i++) {
    onProgress?.(i, stems.length)

    // Yield to the event loop between stems to keep UI responsive
    await new Promise(resolve => setTimeout(resolve, 0))

    const stretched = timeStretch(stems[i].buffer, tempo)
    results.push({ name: stems[i].name, buffer: stretched })
  }

  onProgress?.(stems.length, stems.length)
  return results
}
