# Design: Browser-Powered Stem Separation for weblooper

**Status**: Draft v1 (produced after research + partial design agent run)  
**Date**: 2026-05-26  
**Owner**: Grok + user collaboration  
**Philosophy alignment**: "Offer in the cloud as a regular website, but all heavy work runs on the user's computer."

---

## Overview

Add high-quality music source separation (stems: vocals, drums, bass, guitar, etc.) to weblooper. All ML inference must run **entirely in the visitor's browser** using WASM + WebGPU (or WebNN). The site operator incurs near-zero marginal compute cost after hosting static assets.

This extends weblooper's core promise ("precise practice tool for musicians, no accounts, no tracking, no bullshit") into the audio domain: **zero recurring inference bills**, maximum privacy, and the ability to practice with isolated stems using the same keyboard-first, timeline-driven experience.

**Primary audio source for v1**: User supplies a local audio file (upload / drag & drop). YouTube audio extraction is explicitly out of scope for the first several PRs.

**Primary technical backend**: demucs-rs browser build (WASM + WebGPU port of HTDemucs v4 by nikhilunni). This is the highest-quality open option available in 2026 with a working public demo.

---

## Background & Motivation

Current weblooper ([src/main.ts](/Users/I851355/Projects/weblooper/src/main.ts), the `WebLooper` class) is an excellent focused looper built around the YouTube IFrame Player. It has:

- Precise draggable timeline + loop region
- Excellent keyboard shortcuts (`[`, `]`, `L`, `R`, space, 1-6 for speed, arrows)
- Per-video saved presets in localStorage
- Minimal, high-contrast musician UI

Musicians constantly ask for stem isolation ("can I practice just the guitar solo without the vocals/drums?"). Existing solutions either:
- Require desktop software (Ultimate Vocal Remover, etc.)
- Send audio to someone else's servers (Lalal.ai, Moises, etc.) — cost + privacy + ToS issues
- Are low quality or slow when attempted in-browser (until 2025/2026)

2026 changed the game. Mature open-source projects now deliver near-offline-Demucs quality **client-side**:
- demucs-rs (Rust → WASM + WebGPU) — ~84MB model, real HTDemucs v4 quality, working browser demo.
- demucs-web (ONNX Runtime Web) as a solid fallback.

The user's explicit constraint is the killer feature: **"offer in the cloud, as a regular website, but runs using the user computer power"**. This removes the provider's compute burden entirely and fits the project's soul perfectly.

---

## Goals & Non-Goals

### Goals (v1 scope)

- Fully client-side stem separation using a high-quality model (target: 4-stem or 6-stem HTDemucs-level).
- Clean "user provides audio file" flow as the primary on-ramp.
- Excellent UX for long-running processing: progress, realistic time estimates, cancel, background-friendly, result caching via OPFS.
- Stem-aware practice experience that feels like a natural evolution of the existing looper (not a separate ML toy):
  - Solo / mute / volume per stem
  - Loop region still works on the mixed (or soloed) output
  - Keyboard shortcuts extended naturally
  - Saved "practice mixes" (e.g., "Guitar + Drums at 0.75×")
- Preserve the existing YouTube path unchanged for users who don't care about stems.
- Zero server-side inference in the default path.

### Non-Goals (for the first 2–3 PRs)

- YouTube / streaming audio extraction (user must provide the file).
- Real-time separation while playing.
- On-the-fly pitch shifting or time-stretching of individual stems.
- Cloud sync or account features.
- Mobile-first experience (WebGPU support is still desktop-heavy in 2026; graceful degradation is acceptable).

---

## Proposed Design

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        weblooper UI                         │
│  (existing WebLooper class + new Stem Mode UI)              │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Audio Source Layer                       │
│  • Local file upload / drag-drop (v1)                       │
│  • (later) YouTube → high-quality audio (optional)          │
│  • Decode → AudioBuffer (Web Audio API)                     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  StemEngine Abstraction                     │
│  (src/stems/engine.ts + adapters)                           │
│  • Capability detection (WebGPU? SharedArrayBuffer?)        │
│  • Dynamic import of heavy WASM (lazy)                      │
│  • Progress + cancellation via AbortSignal                  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              Concrete Backend (primary)                     │
│  demucs-rs browser (WASM + WebGPU)                          │
│  • Model: HTDemucs v4 (~84MB recommended)                   │
│  • Runs in Web Worker (off main thread)                     │
│  • Uses SharedArrayBuffer when available                    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                 Stem Result + Caching                       │
│  • OPFS (Origin Private File System) for stems + meta       │
│  • Content-hash keyed (same file = instant next time)       │
│  • Fallback to IndexedDB or memory if OPFS unavailable      │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              Stem-Aware Playback Engine                     │
│  • Multi-source Web Audio graph (one source per stem)       │
│  • Shared loop enforcement + transport (play/pause/seek)    │
│  • Per-stem GainNode + solo/mute state                      │
│  • Re-uses existing timeline + keyboard logic where possible│
└─────────────────────────────────────────────────────────────┘
```

### Integration Points with Existing Code

**Minimal disruption to `WebLooper` (src/main.ts:142)**

- Keep the current YouTube path 100% untouched.
- Add a parallel "Audio Session" or "Stem Mode" state.
- When a local audio file is loaded, we can either:
  - Hide the YouTube player section and show a new stem-focused player, **or**
  - Reuse as much of the existing timeline, controls, and preset system as possible (preferred for consistency).

Recommended: Extract a `PlaybackEngine` interface over time, but for v1 do a pragmatic split:
- `YouTubePlaybackController` (current behavior)
- `StemPlaybackController` (new, Web Audio based)

The timeline component (currently tightly coupled to YouTube time) will need a small abstraction for "current time provider".

**New UI surfaces (to be added incrementally)**

- In loader: the "Load local audio file (for stems)" affordance already added in this session.
- After file load + separation: a stem mixer panel (faders + solo/mute buttons) next to or above the existing sidebar.
- New keyboard shortcuts: e.g. `v` vocals solo, `d` drums solo, `Shift+V` toggle vocals mute, `1-4` or `Shift+1-6` for stem-specific speed? (decide in later PR).
- Visual indication on the timeline that "stems are active".

**Capability & Model Loading Strategy**

- Never load the 80-300MB model on initial page load.
- On first user intent ("Load audio file" or "Separate stems" button), show a friendly "This will download ~85MB the first time and run in your browser" notice.
- Use `createBestStemEngine()` (already stubbed in `src/stems/engine.ts`) with progressive enhancement.

**Caching Strategy (critical for UX)**

Use OPFS + content hashing (SHA-256 of the original audio file bytes, or a fast rolling hash + duration check).

Directory structure idea inside OPFS:
```
weblooper-stems/
  <hash>/
    meta.json
    vocals.wav
    drums.wav
    ...
```

This makes repeat visits to the same song feel instant.

---

## Data Model Changes

### New (in-memory + persisted)

```ts
interface StemSession {
  id: string
  sourceFileName: string
  sourceDuration: number
  stems: Stem[]                    // from src/stems/types.ts
  createdAt: number
  model: string
}

interface StemPracticePreset {
  id: string
  name: string
  // which stems are audible + their relative gains
  stemMix: Record<StemName, { gain: number; muted: boolean; soloed?: boolean }>
  loopStart: number
  loopEnd: number
  playbackRate: number
}
```

These can live alongside the existing `VideoState` / localStorage model, or in a new `audioSessions` top-level key. Prefer OPFS for the actual audio data; keep lightweight metadata in localStorage or IndexedDB.

---

## Alternatives Considered

1. **Use an external paid API (Lalal.ai, Moises, etc.) as primary**
   - Pros: Highest quality + fast, no large downloads.
   - Cons: Costs real money at scale, privacy (user audio leaves the device), contradicts the "user's computer does the work" vision.
   - Decision: Reject for the core path. Could be offered later as an optional "instant cloud stems" upgrade.

2. **ONNX Runtime Web + demucs-web as primary instead of demucs-rs**
   - demucs-web is more "npm library" friendly and has good docs.
   - However, demucs-rs is a higher-fidelity Rust port of the actual best model (HTDemucs v4) and already has a polished browser demo.
   - Decision: demucs-rs is primary; demucs-web or a lighter distilled model is acceptable fallback.

3. **Full Electron / Tauri desktop app for better performance**
   - Would give native GPU access and easier file handling.
   - But it abandons the "regular website anyone can open" promise that the user specifically wants.
   - Decision: Keep web-first. A companion desktop helper can be a future stretch goal.

---

## Security & Privacy Considerations

- **Audio never leaves the device** in the default path (big privacy win).
- Large WASM downloads: serve from a reputable CDN or Hugging Face with SRI/subresource integrity where possible.
- OPFS is origin-scoped — no cross-site leakage.
- Capability detection must not be used for fingerprinting beyond what's necessary for a good error message.
- Model weights are static and auditable (open source).

---

## Observability (for the web app itself)

- Console + optional `?debug=1` panel showing:
  - Which engine was chosen
  - WebGPU adapter info
  - Processing time vs estimate
  - Cache hit/miss
- No telemetry to any server by default (consistent with existing philosophy).

---

## Rollout Plan

1. **Foundation PRs** (this work + next 1-2 PRs)
   - Vite headers + basic capability detection
   - Local audio file loading + decoding to AudioBuffer
   - `StemEngine` abstraction + demucs-rs adapter spike (can be behind a feature flag or `localhost` only)

2. **First user-visible milestone**
   - User can load a file → trigger separation (with good progress UI) → see 4 stem faders + solo/mute
   - Basic mixing + loop still works on the sum

3. **Polish & keyboard integration**
   - Extend shortcuts
   - Saveable stem mixes / practice presets
   - OPFS caching so second load is near-instant

4. **Later**
   - Optional lighter "fast mode" model for quick previews
   - YouTube audio bring-your-own (user downloads high-quality audio elsewhere and drops it in)
   - 6-stem variant

Use a URL flag (`?stems=1`) or a settings toggle during the experimental phase.

---

## Open Questions (for user decision)

1. **Stem count for v1**: 4-stem (vocals/drums/bass/other) or go straight to 6-stem (adds guitar + piano)?
2. **Default stem mix on first load**: All stems at 0 dB (full mix), or "vocals + drums only" as a practice-friendly default?
3. **How aggressive should we be with model size warning?** (e.g. show a one-time modal explaining the ~85MB download + that it runs locally?)
4. **Keyboard shortcut philosophy**: Keep it extremely sparse (only the most common actions get keys) or give stems their own layer (e.g. hold `S` + letter for stem actions)?

---

## PR Plan (Incremental & Mergeable)

| PR | Title | Scope | Dependencies | Key Files |
|----|-------|-------|--------------|-----------|
| 1 | Infrastructure: COOP/COEP headers + basic audio file loading | Vite config, file input UI + decode stub, early capability check | None | `vite.config.ts`, `src/main.ts` (loader section + `loadLocalAudioFile`) |
| 2 | Stem types + engine abstraction + capability detection | `src/stems/` module, `StemEngine` interface, `hasMinimumBrowserCapabilities`, dynamic import skeleton | PR 1 | `src/stems/types.ts`, `engine.ts`, `index.ts` |
| 3 | Local audio → Web Audio playback (no stems yet) | Proper `AudioContext`, buffer source, basic transport controls that feel like the existing player | PR 1,2 | New `src/audio/` or inside stems, integration into main UI |
| 4 | demucs-rs adapter spike (can be localhost-only or flag-gated) | Wire real WASM engine behind the abstraction, progress reporting, basic cancellation | PR 2,3 | `src/stems/demucs-rs-adapter.ts` (new), heavy dynamic import |
| 5 | Stem mixer UI + solo/mute/volume | Visual panel with faders, keyboard shortcuts for common stem actions, mixing in Web Audio graph | PR 4 | New components in `src/main.ts` or small dedicated module, CSS additions |
| 6 | OPFS caching layer + result persistence | Content-hash stems, "already processed" fast path, storage quota handling | PR 4 | `src/stems/cache.ts` |
| 7 | Polish: saved stem practice presets, better error states, time estimates, docs | Full integration with existing preset system, updated README + docs/stem-separation.md | All previous | `src/main.ts`, docs, README |

Each PR should be reviewable and shippable independently where possible. Early PRs deliver user-visible progress even before real separation works.

---

## Key Decisions (with Rationale)

1. **demucs-rs browser as primary backend**  
   Rationale: Highest quality open model in 2026 with a working WASM+WebGPU implementation and public demo. Aligns with "best possible experience using user's hardware."

2. **User-provided audio files only for v1 (no YouTube extraction)**  
   Rationale: Directly follows the user's statement ("I believe we can provide the audio for now"). Avoids the hardest and most fragile part of the problem while still delivering massive value.

3. **Lazy + capability-gated loading of the heavy WASM**  
   Rationale: 85–300MB is too large to pay on every page load. Matches weblooper's "focused" philosophy — the feature only activates when the user wants it.

4. **OPFS for stem result caching**  
   Rationale: Makes the experience magical on repeat practice sessions. One of the biggest advantages of client-side processing.

5. **Pragmatic split of playback controllers rather than big refactor of WebLooper upfront**  
   Rationale: The current `WebLooper` class is large but coherent. We can evolve toward better abstractions over time without blocking the stem feature.

6. **Preserve the existing YouTube path completely untouched**  
   Rationale: Avoids regressing current users. Stems is a powerful new mode, not a replacement.

---

## References

- demucs-rs browser demo & source: https://github.com/nikhilunni/demucs-rs (web/ folder + public demo)
- demucs-web: https://github.com/timcsy/demucs-web + EXPERIENCE_REPORT.md
- HTDemucs v4 paper and original Demucs work (Rouard et al.)
- WebGPU + WASM + SharedArrayBuffer constraints in modern browsers (2026)
- OPFS (Origin Private File System) spec and practical usage patterns

---

*This document was produced to keep momentum after the automated design skill run was blocked by a permission prompt during subagent execution. It incorporates all prior research and conversation context.*
