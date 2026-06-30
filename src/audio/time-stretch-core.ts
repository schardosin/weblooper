/**
 * Core SoundTouch time-stretch logic shared by the main thread and Web Worker.
 */

import { SoundTouch, SimpleFilter } from 'soundtouchjs'

export interface ChannelSource {
  extract(target: Float32Array, numFrames: number, position: number): number
}

class ArrayChannelSource implements ChannelSource {
  private channels: Float32Array[]
  position = 0

  constructor(channels: Float32Array[]) {
    this.channels = channels
  }

  extract(target: Float32Array, numFrames: number, position: number): number {
    this.position = position
    const left = this.channels[0]
    const right = this.channels.length > 1 ? this.channels[1] : left

    const available = Math.min(numFrames, left.length - position)
    if (available <= 0) return 0

    for (let i = 0; i < available; i++) {
      target[i * 2] = left[position + i]
      target[i * 2 + 1] = right[position + i]
    }

    return available
  }
}

export interface StretchChannelsResult {
  channels: Float32Array[]
  length: number
}

/**
 * Time-stretch interleaved channel data with optional pitch shift.
 */
export function stretchChannels(
  channels: Float32Array[],
  tempo: number,
  pitchSemitones: number,
): StretchChannelsResult {
  const needsTempo = Math.abs(tempo - 1.0) >= 0.01
  const needsPitch = Math.abs(pitchSemitones) >= 0.01

  if (!needsTempo && !needsPitch) {
    const length = channels[0].length
    return { channels, length }
  }

  const numChannels = Math.min(channels.length, 2)
  const originalLength = channels[0].length
  const expectedLength = Math.ceil(originalLength / tempo)

  const st = new SoundTouch()
  st.tempo = tempo
  st.pitch = needsPitch ? Math.pow(2, pitchSemitones / 12) : 1.0

  const source = new ArrayChannelSource(channels)
  const filter = new SimpleFilter(source, st)

  const CHUNK_SIZE = 8192
  const outputChunks: Float32Array[] = []
  let totalFrames = 0

  while (true) {
    const chunk = new Float32Array(CHUNK_SIZE * 2)
    const framesExtracted = filter.extract(chunk, CHUNK_SIZE)

    if (framesExtracted === 0) break

    if (framesExtracted < CHUNK_SIZE) {
      outputChunks.push(chunk.subarray(0, framesExtracted * 2))
    } else {
      outputChunks.push(chunk)
    }
    totalFrames += framesExtracted

    if (totalFrames > expectedLength * 3) break
  }

  let skipFrames = 0
  if (!needsTempo && needsPitch && totalFrames > originalLength) {
    skipFrames = totalFrames - originalLength
  }

  const finalLength = needsTempo ? totalFrames : originalLength
  const leftOut = new Float32Array(finalLength)
  const rightOut = numChannels > 1 ? new Float32Array(finalLength) : null

  let writeOffset = 0
  let skipped = 0

  for (const chunk of outputChunks) {
    const frames = chunk.length / 2
    let startFrame = 0

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

  const outChannels: Float32Array[] = [leftOut]
  if (rightOut) outChannels.push(rightOut)

  return { channels: outChannels, length: finalLength }
}