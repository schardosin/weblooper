/**
 * Opus/WebM Encoder — Encode AudioBuffer to compressed Opus audio in a WebM container.
 *
 * Uses the native WebCodecs AudioEncoder API (Chrome/Edge 94+) for encoding
 * and the webm-muxer library for container packaging.
 *
 * Typical output sizes:
 *   4-minute stereo stem @ 128kbps → ~3.8 MB (vs ~84 MB raw PCM)
 *
 * This enables efficient upload to Google Drive for cross-device sync.
 */

import { Muxer, ArrayBufferTarget } from 'webm-muxer'

/**
 * Check if the WebCodecs AudioEncoder is available and supports Opus.
 */
export function isOpusEncoderSupported(): boolean {
  return typeof AudioEncoder !== 'undefined'
}

export interface EncodeOptions {
  /** Bitrate in bps (default: 128000 = 128kbps) */
  bitrate?: number
  /** Progress callback (0-100) */
  onProgress?: (percent: number) => void
}

/**
 * Encode an AudioBuffer to Opus/WebM format.
 * Returns compressed audio as an ArrayBuffer ready for upload.
 *
 * The AudioBuffer is resampled to 48kHz if needed (Opus requires 48kHz).
 */
export async function encodeToOpusWebM(
  buffer: AudioBuffer,
  options?: EncodeOptions,
): Promise<ArrayBuffer> {
  if (!isOpusEncoderSupported()) {
    throw new Error('WebCodecs AudioEncoder not available in this browser')
  }

  const bitrate = options?.bitrate ?? 128_000
  const onProgress = options?.onProgress

  // Opus requires 48kHz. Resample if needed.
  const targetSampleRate = 48000
  const audioBuffer = buffer.sampleRate !== targetSampleRate
    ? await resampleBuffer(buffer, targetSampleRate)
    : buffer

  const numberOfChannels = Math.min(audioBuffer.numberOfChannels, 2) // Opus supports max 2 for stereo
  const sampleRate = audioBuffer.sampleRate
  const totalFrames = audioBuffer.length

  // Set up the WebM muxer (audio-only)
  const target = new ArrayBufferTarget()
  const muxer = new Muxer({
    target,
    type: 'webm',
    audio: {
      codec: 'A_OPUS',
      sampleRate,
      numberOfChannels,
    },
  })

  // Set up the AudioEncoder
  let encodedChunks = 0
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      muxer.addAudioChunk(chunk, meta)
      encodedChunks++
    },
    error: (e) => {
      console.error('[opus-encoder] Encoding error:', e)
    },
  })

  encoder.configure({
    codec: 'opus',
    sampleRate,
    numberOfChannels,
    bitrate,
  })

  // Feed audio data in chunks (20ms frames for Opus = 960 samples at 48kHz)
  const frameSize = Math.floor(sampleRate * 0.02) // 20ms = 960 samples at 48kHz
  const totalChunks = Math.ceil(totalFrames / frameSize)
  let processedChunks = 0

  for (let offset = 0; offset < totalFrames; offset += frameSize) {
    const remainingFrames = Math.min(frameSize, totalFrames - offset)
    const timestamp = Math.round((offset / sampleRate) * 1_000_000) // microseconds

    // Create interleaved or planar data for AudioData
    // AudioData with f32-planar: channel data laid out sequentially
    const data = new Float32Array(numberOfChannels * remainingFrames)
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const channelData = audioBuffer.getChannelData(ch)
      data.set(channelData.subarray(offset, offset + remainingFrames), ch * remainingFrames)
    }

    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate,
      numberOfFrames: remainingFrames,
      numberOfChannels,
      timestamp,
      data,
    })

    encoder.encode(audioData)
    audioData.close()

    processedChunks++
    if (onProgress && processedChunks % 50 === 0) {
      onProgress(Math.round((processedChunks / totalChunks) * 100))
    }
  }

  // Flush remaining encoded data
  await encoder.flush()
  encoder.close()

  // Finalize the WebM container
  muxer.finalize()

  onProgress?.(100)

  return target.buffer
}

/**
 * Resample an AudioBuffer to a target sample rate using OfflineAudioContext.
 */
async function resampleBuffer(buffer: AudioBuffer, targetSampleRate: number): Promise<AudioBuffer> {
  const numberOfChannels = buffer.numberOfChannels
  const duration = buffer.duration
  const targetLength = Math.round(duration * targetSampleRate)

  const offlineCtx = new OfflineAudioContext(numberOfChannels, targetLength, targetSampleRate)
  const source = offlineCtx.createBufferSource()
  source.buffer = buffer
  source.connect(offlineCtx.destination)
  source.start(0)

  return await offlineCtx.startRendering()
}
