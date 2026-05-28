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
  // When doing pure pitch shift (tempo=1.0), SoundTouch's WSOLA introduces a small
  // latency at the start (the algorithm needs to fill its overlap window before producing
  // meaningful output). This causes the output to be shifted forward in time.
  // We compensate by detecting and skipping the leading latency.
  let skipFrames = 0
  if (!needsTempo && needsPitch && totalFrames > originalLength) {
    // The excess frames are the latency — skip them from the beginning
    skipFrames = totalFrames - originalLength
  }

  const finalLength = needsTempo ? totalFrames : originalLength
  const ctx = new OfflineAudioContext(numChannels, finalLength, sampleRate)
  const outputBuffer = ctx.createBuffer(numChannels, finalLength, sampleRate)

  const leftOut = outputBuffer.getChannelData(0)
  const rightOut = numChannels > 1 ? outputBuffer.getChannelData(1) : null

  let writeOffset = 0  // position in the final buffer
  let skipped = 0

  for (const chunk of outputChunks) {
    const frames = chunk.length / 2
    let startFrame = 0

    // Skip leading frames (SoundTouch latency)
    if (skipped < skipFrames) {
      const toSkip = Math.min(frames, skipFrames - skipped)
      startFrame = toSkip
      skipped += toSkip
    }

    for (let i = startFrame; i < frames && writeOffset < finalLength; i++) {
      leftOut[writeOffset] = chunk[i * 2]
      if (rightOut) {
        rightOut[writeOffset] = chunk[i * 2 + 1]
      }
      writeOffset++
    }

    if (writeOffset >= finalLength) break
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
