/**
 * Heuristic low-memory detection for adaptive audio processing.
 * navigator.deviceMemory is missing on many embedded browsers (e.g. Lava Studio);
 * treat unknown as low-memory to stay safe.
 */
export function isLowMemoryDevice(): boolean {
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  return mem == null || mem <= 4
}

export function stretchCacheMaxEntries(): number {
  return isLowMemoryDevice() ? 0 : 2
}