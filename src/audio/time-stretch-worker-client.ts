/**
 * Client for the time-stretch Web Worker.
 * Queues requests and falls back to main-thread processing if the worker fails.
 */

import { stretchChannels } from './time-stretch-core'

export class StretchCancelledError extends Error {
  constructor() {
    super('Stretch cancelled')
    this.name = 'StretchCancelledError'
  }
}

interface StretchJob {
  id: number
  channels: Float32Array[]
  tempo: number
  pitchSemitones: number
  resolve: (result: { channels: Float32Array[]; length: number }) => void
  reject: (err: Error) => void
}

let worker: Worker | null = null
let workerFailed = false
let nextId = 1
const pending = new Map<number, StretchJob>()
const queue: StretchJob[] = []
let busy = false

function createWorker(): Worker {
  return new Worker(
    new URL('./workers/time-stretch-worker.ts', import.meta.url),
    { type: 'module' },
  )
}

function ensureWorker(): Worker | null {
  if (workerFailed) return null
  if (!worker) {
    try {
      worker = createWorker()
      worker.onmessage = handleWorkerMessage
      worker.onerror = () => {
        workerFailed = true
        worker?.terminate()
        worker = null
        drainQueueOnMainThread()
      }
    } catch {
      workerFailed = true
      return null
    }
  }
  return worker
}

function handleWorkerMessage(e: MessageEvent) {
  const msg = e.data
  if (msg.type === 'result') {
    const job = pending.get(msg.id)
    if (job) {
      pending.delete(msg.id)
      job.resolve({ channels: msg.channels, length: msg.length })
    }
  } else if (msg.type === 'error') {
    const job = pending.get(msg.id)
    if (job) {
      pending.delete(msg.id)
      job.reject(new Error(msg.message))
    }
  }

  busy = false
  pumpQueue()
}

async function runOnMainThread(job: StretchJob) {
  await new Promise(resolve => setTimeout(resolve, 0))
  try {
    const result = stretchChannels(job.channels, job.tempo, job.pitchSemitones)
    job.resolve(result)
  } catch (err) {
    job.reject(err instanceof Error ? err : new Error(String(err)))
  }
}

function drainQueueOnMainThread() {
  while (queue.length > 0) {
    const job = queue.shift()!
    pending.delete(job.id)
    void runOnMainThread(job)
  }
  busy = false
}

function pumpQueue() {
  if (busy || queue.length === 0) return

  const w = ensureWorker()

  if (!w) {
    busy = true
    const current = queue.shift()!
    void runOnMainThread(current).finally(() => {
      busy = false
      pumpQueue()
    })
    return
  }

  busy = true
  const current = queue.shift()!
  const transfers = current.channels.map(ch => ch.buffer)

  w.postMessage(
    {
      type: 'stretch',
      id: current.id,
      channels: current.channels,
      tempo: current.tempo,
      pitchSemitones: current.pitchSemitones,
    },
    { transfer: transfers },
  )
}

/** Drop queued (not yet running) stretch jobs — e.g. when a newer tempo commit supersedes them. */
export function cancelPendingStretchJobs(): void {
  while (queue.length > 0) {
    const job = queue.shift()!
    pending.delete(job.id)
    job.reject(new StretchCancelledError())
  }
}

export function stretchChannelsAsync(
  channels: Float32Array[],
  tempo: number,
  pitchSemitones: number,
): Promise<{ channels: Float32Array[]; length: number }> {
  return new Promise((resolve, reject) => {
    const id = nextId++
    const job: StretchJob = { id, channels, tempo, pitchSemitones, resolve, reject }
    pending.set(id, job)
    queue.push(job)
    pumpQueue()
  })
}