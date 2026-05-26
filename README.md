# weblooper

**A focused YouTube looper for musicians.**

Set precise start and end points on any YouTube video, loop it, slow it down, and save your favorite practice sections.

Built for deliberate practice — guitar solos, vocal runs, drum fills, piano passages, language listening, etc.

## Features (YouTube)

- **Precise loop region** — click or drag handles on the timeline, or use the `[` / `]` keys
- **Live visual timeline** with playhead and highlighted loop region
- **Playback speed control** — 0.5×, 0.75×, 1×, 1.25×, 1.5×, 2×
- **Fine nudging** — adjust start/end by 0.5s (or edit the time fields directly)
- **Saved loops / presets** — name sections ("Verse 2", "Bridge solo", "Slow chorus") and jump between them instantly
- **Keyboard-first** — space, brackets, L, R, arrows, number keys for speed
- **Remembers everything** — per-video loop points + presets are saved in your browser

## Planned

- **Browser-powered stem separation** (full 6-stem only: drums, bass, **guitar**, **piano**, vocals, other) — **exclusive engine is demucs-rs** (Rust + WebGPU/WASM). 4-stem support has been fully removed. See `src/stems/` and [docs/stem-separation.md](docs/stem-separation.md).
- Spotify support (and other platforms)
- Count-in / metronome overlay
- Export / share loop links
- Offline / PWA install

## Getting started

```bash
npm install
npm run dev
```

Open http://localhost:5173, paste any YouTube URL (or video ID), and start looping.

### Recommended workflow for practice

1. Load the song
2. Play the section you want to practice
3. Hit `[` at the start of the phrase
4. Hit `]` at the end of the phrase
5. Hit `L` to turn looping on
6. Slow it down to 0.75× or 0.5× using the speed chips or `1`–`6` keys
7. Hit `R` anytime to restart the phrase cleanly
8. Save it with a name so you can come back tomorrow

## Keyboard shortcuts

| Key       | Action                        |
|-----------|-------------------------------|
| `Space`   | Play / Pause                  |
| `[`       | Set loop **start** here       |
| `]`       | Set loop **end** here         |
| `L`       | Toggle looping                |
| `R`       | Restart from loop start       |
| `1`–`6`   | Change speed (0.5× → 2×)      |
| `←` / `→` | Seek ±1 second                |
| `?`       | Show shortcuts                |
| `Esc`     | Close dialogs                 |

You can also drag the green handles directly on the timeline for visual precision.

## Tech

- Vite + TypeScript + Tailwind CSS v4
- YouTube IFrame Player API (no backend, no data collection)
- All state lives in `localStorage` (per video)

## Deploy

This is a pure static site. Deploy anywhere Vite works:

- **Vercel**: `vercel`
- **Netlify**: drag `dist/` or connect repo
- **GitHub Pages**: `npm run build` + push `dist` (or use a workflow)

## Contributing / Philosophy

The goal is to stay extremely focused:

- One job: help musicians loop specific musical phrases perfectly
- Minimal UI chrome
- Keyboard and precision first
- No accounts, no tracking, no bullshit

## License

MIT — do whatever you want with it.

---

Made with ❤️ for people who practice the hard parts.
