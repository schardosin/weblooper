// Minimal type shim for soundtouchjs
// Covers the parts used in this project for time-stretching.

declare module 'soundtouchjs' {
  export class SoundTouch {
    tempo: number
    pitch: number
    rate: number
  }

  export class SimpleFilter {
    constructor(source: any, soundTouch: SoundTouch)
    extract(target: Float32Array, numFrames: number): number
  }
}
