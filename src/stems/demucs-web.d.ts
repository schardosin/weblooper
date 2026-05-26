// Minimal type shim for demucs-web until official types exist.
// Covers the parts we actually use in this project.

declare module 'demucs-web' {
  export const CONSTANTS: {
    DEFAULT_MODEL_URL?: string
    SAMPLE_RATE: number
    [key: string]: any
  }

  export class DemucsProcessor {
    constructor(options: any)
    loadModel(pathOrBuffer?: string | ArrayBuffer): Promise<void>
    separate(left: Float32Array, right: Float32Array): Promise<{
      drums: { left: Float32Array; right: Float32Array }
      bass: { left: Float32Array; right: Float32Array }
      other: { left: Float32Array; right: Float32Array }
      vocals: { left: Float32Array; right: Float32Array }
    }>
  }

  export function fft(...args: any[]): void
  export function ifft(...args: any[]): void
  export function stft(...args: any[]): any
  export function istft(...args: any[]): any
  export function reflectPad(...args: any[]): any
}
