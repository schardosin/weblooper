/**
 * Web Worker for pitch-preserving time-stretching (SoundTouch WSOLA).
 * Keeps heavy CPU work off the main thread so the UI stays responsive.
 */

import { stretchChannels } from '../time-stretch-core'

interface StretchRequest {
  type: 'stretch'
  id: number
  channels: Float32Array[]
  tempo: number
  pitchSemitones: number
}

interface StretchResult {
  type: 'result'
  id: number
  channels: Float32Array[]
  length: number
}

interface StretchError {
  type: 'error'
  id: number
  message: string
}

self.onmessage = (e: MessageEvent<StretchRequest>) => {
  const msg = e.data
  if (msg.type !== 'stretch') return

  try {
    const { channels, length } = stretchChannels(msg.channels, msg.tempo, msg.pitchSemitones)
    const transfers = channels.map(ch => ch.buffer)

    const result: StretchResult = {
      type: 'result',
      id: msg.id,
      channels,
      length,
    }

    self.postMessage(result, { transfer: transfers })
  } catch (err) {
    const error: StretchError = {
      type: 'error',
      id: msg.id,
      message: err instanceof Error ? err.message : String(err),
    }
    self.postMessage(error)
  }
}