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
 * Time-stretch an AudioBuffer with optional independent pitch shift.
 *
 * @param buffer          The source AudioBuffer
 * @param tempo           The tempo multiplier (e.g. 0.75 = 75% speed)
 * @param pitchSemitones  Pitch shift in semitones (positive = higher key, negative = lower key). 0 = no change.
 * @returns               A new AudioBuffer at the adjusted tempo and pitch
 */
export function timeStretch(buffer: AudioBuffer, tempo: number, pitchSemitones: number = 0): AudioBuffer {
  const needsTempo = Math.abs(tempo - 1.0) >= 0.01
  const needsPitch = Math.abs(pitchSemitones) >= 0.01

  if (!needsTempo && !needsPitch) {
    return buffer
  }

  const sampleRate = buffer.sampleRate
  const numChannels = Math.min(buffer.numberOfChannels, 2)
  const originalLength = buffer.length

  // Expected output length (approximate)
  const expectedLength = Math.ceil(originalLength / tempo)

  // Set up SoundTouch
  const st = new SoundTouch()
  st.tempo = tempo

  // Convert semitones to pitch factor (each semitone = 2^(1/12))
  if (needsPitch) {
    st.pitch = Math.pow(2, pitchSemitones / 12)
  } else {
    st.pitch = 1.0
  }

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
 * Time-stretch (and optionally pitch-shift) multiple AudioBuffers.
 * Used for stem practice with independent tempo and key control.
 */
export async function timeStretchStems(
  stems: Array<{ name: string; buffer: AudioBuffer }>,
  tempo: number,
  pitchSemitones: number = 0,
  onProgress?: (stemIndex: number, totalStems: number) => void,
): Promise<Array<{ name: string; buffer: AudioBuffer }>> {
  const needsProcessing = Math.abs(tempo - 1.0) >= 0.01 || Math.abs(pitchSemitones) >= 0.01
  if (!needsProcessing) {
    return stems
  }

  const results: Array<{ name: string; buffer: AudioBuffer }> = []

  for (let i = 0; i < stems.length; i++) {
    onProgress?.(i, stems.length)

    await new Promise(resolve => setTimeout(resolve, 0))

    const processed = timeStretch(stems[i].buffer, tempo, pitchSemitones)
    results.push({ name: stems[i].name, buffer: processed })
  }

  onProgress?.(stems.length, stems.length)
  return results
}
