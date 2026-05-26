# Stem Separation — Browser-Powered (Zero Server Compute)

**Vision**: Offer a powerful, free stem separation feature inside weblooper as a normal website. All heavy ML inference runs on the *visitor's own computer* using WASM + WebGPU. The provider pays near-zero marginal cost after hosting the static assets and model weights.

This matches weblooper's philosophy: focused on musicians, no accounts, no tracking, no bullshit — now extended to "no recurring inference bills either".

## Current Status (May 2026) — Engine Decision Made

**Primary and only engine:** **demucs-rs** (nikhilunni) + `htdemucs_6s` model.

This is the full 6-stem experience the user requested:
- Drums, Bass, **Guitar**, **Piano**, Vocals, Other

- `htdemucs_6s` (~55 MB). 4-stem support (previous demucs-web path) has been completely removed.
- Audio source for v1: User provides local audio file.

The demucs-rs WASM + WebGPU integration is now the sole focus.

**Important (May 2026):** The original Hugging Face repo `nikhilunni/demucs-rs` now returns 404.  
The model weights (`htdemucs_6s.safetensors` etc.) are hosted at:

> https://huggingface.co/set-soft/audio_separation/tree/main/Demucs

This location is the source of truth referenced inside the demucs-rs project itself (`demucs-core/src/model/metadata.rs`).  
The code in `src/stems/workers/demucs-rs-worker.ts` and the adapter now point here. A free Hugging Face read token may still be required for the download.

## Technical Foundations Already in Place

- [vite.config.ts](/Users/I851355/Projects/weblooper/vite.config.ts) — COOP/COEP headers in dev + preview (required for SharedArrayBuffer / multi-threaded WASM).
- `src/stems/` — clean type + engine abstraction started.
- Local audio file input UI wired in the loader section (non-breaking addition).

## Next Steps

See the generated design document (produced via the design skill) for the full architecture, integration plan, PR breakdown, and open questions.

The design lives at:
- `/tmp/grok-design-doc-7526fe2b.md` (during active design run)
- Will be moved into `docs/` once the write/review loop completes.

## Key Constraints (non-negotiable)

- Processing must be 100% client-side in the default path.
- Must feel like a natural extension of weblooper, not a generic ML demo.
- Preserve keyboard-first, precise, minimal aesthetic.
- Caching via OPFS so re-processing the same song is instant on repeat visits.

## How to Enable Real 6-Stem Separation (demucs-rs)

The UI and architecture are fully ready for 6-stem. The missing piece is the compiled WASM artifact from the demucs-rs project.

### Step-by-step (one time)

1. Clone demucs-rs:
   ```bash
   git clone https://github.com/nikhilunni/demucs-rs.git
   cd demucs-rs
   ```

2. Install wasm-pack (if you don't have it):
   ```bash
   cargo install wasm-pack
   ```

3. Build the WASM for the web (release):
   ```bash
   cd demucs-wasm
   wasm-pack build --target web --out-dir /tmp/demucs-wasm-out --release
   ```

4. Copy the generated files into weblooper (source tree, not public/):
   ```bash
   mkdir -p /path/to/weblooper/src/vendor/demucs-rs
   cp /tmp/demucs-wasm-out/* /path/to/weblooper/src/vendor/demucs-rs/
   ```

5. (Optional) Also copy the model weights if you want offline use.

6. Run `npm run dev` in weblooper and load an audio file → "Separate Stems".

The worker will detect the WASM and the real inference will run.

**Current state**: The WASM artifacts must be built locally (see script below) and placed in `src/vendor/demucs-rs/`. Once present, the worker loads them via proper Vite `import.meta.url` resolution. The model weights are fetched at runtime from Hugging Face (set-soft/audio_separation) when the user triggers separation.

## Related

- Main README "Planned" section
- `src/stems/` (especially `demucs-rs-adapter.ts` and `workers/demucs-rs-worker.ts`)
- `src/audio/decoder.ts` (audio file handling)
