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
let activeJobId: number | null = null

function createWorker(): Worker {
  return new Worker(
    new URL('./workers/time-stretch-worker.ts', import.meta.url),
    { type: 'module' },
  )
}

function rejectAllPending(err: Error) {
  for (const job of pending.values()) {
    job.reject(err)
  }
  pending.clear()
  queue.length = 0
  activeJobId = null
  busy = false
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
        rejectAllPending(new Error('Stretch worker failed'))
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
      if (activeJobId === msg.id) activeJobId = null
      job.resolve({ channels: msg.channels, length: msg.length })
    }
  } else if (msg.type === 'error') {
    const job = pending.get(msg.id)
    if (job) {
      pending.delete(msg.id)
      if (activeJobId === msg.id) activeJobId = null
      job.reject(new Error(msg.message))
    }
  }

  busy = false
  pumpQueue()
}

async function runOnMainThread(job: StretchJob) {
  activeJobId = job.id
  await new Promise(resolve => setTimeout(resolve, 0))
  try {
    const result = stretchChannels(job.channels, job.tempo, job.pitchSemitones)
    pending.delete(job.id)
    if (activeJobId === job.id) activeJobId = null
    job.resolve(result)
  } catch (err) {
    pending.delete(job.id)
    if (activeJobId === job.id) activeJobId = null
    job.reject(err instanceof Error ? err : new Error(String(err)))
  }
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
  activeJobId = current.id
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

/** Terminate the worker and reject all pending / in-flight jobs. */
export function terminateStretchWorker(): void {
  if (worker) {
    worker.terminate()
    worker = null
  }
  workerFailed = false
  rejectAllPending(new StretchCancelledError())
}

/** Drop queued and in-flight stretch jobs (e.g. when a newer tempo commit supersedes them). */
export function cancelPendingStretchJobs(): void {
  terminateStretchWorker()
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