/**
 * Time-stretching utility using SoundTouch.js
 *
 * Changes playback speed without changing pitch (WSOLA algorithm).
 * Used by the StemPlayer to provide pitch-preserved tempo control.
 */

import { stretchChannels } from './time-stretch-core'
import { stretchChannelsAsync } from './time-stretch-worker-client'

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

    for (let i = 0; i < available; i++) {
      target[i * 2] = left[position + i]
      target[i * 2 + 1] = right[position + i]
    }

    return available
  }
}

function bufferToChannels(buffer: AudioBuffer): Float32Array[] {
  const numChannels = Math.min(buffer.numberOfChannels, 2)
  const channels: Float32Array[] = []
  for (let i = 0; i < numChannels; i++) {
    channels.push(buffer.getChannelData(i).slice())
  }
  return channels
}

function channelsToAudioBuffer(
  channels: Float32Array[],
  length: number,
  sampleRate: number,
): AudioBuffer {
  const numChannels = channels.length
  const ctx = new OfflineAudioContext(numChannels, length, sampleRate)
  const outputBuffer = ctx.createBuffer(numChannels, length, sampleRate)

  for (let i = 0; i < numChannels; i++) {
    outputBuffer.getChannelData(i).set(channels[i].subarray(0, length))
  }

  return outputBuffer
}

/**
 * Time-stretch an AudioBuffer with optional independent pitch shift.
 * Synchronous — prefer timeStretchAsync for stem playback to avoid blocking the UI.
 */
export function timeStretch(buffer: AudioBuffer, tempo: number, pitchSemitones: number = 0): AudioBuffer {
  const needsTempo = Math.abs(tempo - 1.0) >= 0.01
  const needsPitch = Math.abs(pitchSemitones) >= 0.01

  if (!needsTempo && !needsPitch) {
    return buffer
  }

  const channels = bufferToChannels(buffer)
  const { channels: outChannels, length } = stretchChannels(channels, tempo, pitchSemitones)
  return channelsToAudioBuffer(outChannels, length, buffer.sampleRate)
}

/**
 * Time-stretch an AudioBuffer off the main thread (Web Worker).
 */
export async function timeStretchAsync(
  buffer: AudioBuffer,
  tempo: number,
  pitchSemitones: number = 0,
): Promise<AudioBuffer> {
  const needsTempo = Math.abs(tempo - 1.0) >= 0.01
  const needsPitch = Math.abs(pitchSemitones) >= 0.01

  if (!needsTempo && !needsPitch) {
    return buffer
  }

  const channels = bufferToChannels(buffer)
  const { channels: outChannels, length } = await stretchChannelsAsync(channels, tempo, pitchSemitones)
  return channelsToAudioBuffer(outChannels, length, buffer.sampleRate)
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

    const processed = await timeStretchAsync(stems[i].buffer, tempo, pitchSemitones)
    results.push({ name: stems[i].name, buffer: processed })
  }

  onProgress?.(stems.length, stems.length)
  return results
}

// Re-export for tests / advanced use
export { AudioBufferSource }