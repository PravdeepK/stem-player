# Stem Player

Personal, non-commercial Electron app.

- **Phase 1** — load a local audio file, split it into 4 stems (vocals, drums,
  bass, instrumental) with [Demucs] (`htdemucs` / `htdemucs_ft`, on the GPU or CPU).
  "instrumental" is
  Demucs' `other` stem, renamed.
- **Phase 2** — load the 4 stems into a Web Audio mixer: synchronized
  play/pause/seek, per-stem volume / mute / solo, waveform per stem
  (waveforms via wavesurfer.js, audio via the Web Audio graph).
- **Phase 3** — a 3D recreation of the hardware is the control surface, drawn
  live with three.js from a model built in Blender, turned by dragging it, with
  trackpad haptics. Optional beat taps (menu → Haptics, off by default) tap
  the trackpad on each drum hit, found ahead of time from the drums stem;
  turning the volume down lets only the harder hits through.

## Prerequisites

- macOS
- Node 18+ (tested on v22)
- Python 3 with `demucs` installed for the interpreter you'll use:

  ```sh
  python3 -m pip install --user demucs
  ```

  If your `demucs` lives in a different interpreter/venv, point the app at it:

  ```sh
  export STEM_PLAYER_PYTHON=/path/to/venv/bin/python
  ```

  The app auto-probes a few common interpreters (`python3` on PATH, Homebrew,
  the python.org framework builds) and picks the first that can `import demucs`,
  so an active conda env on PATH usually isn't a problem. `STEM_PLAYER_PYTHON`
  overrides the probe if you need a specific one:

  ```sh
  STEM_PLAYER_PYTHON=/path/to/python npm run dev
  ```

- Model is selectable in the UI (remembered in `<userData>/config.json`):
  - **Fast — `htdemucs`** (default): ~80 MB weights, quickest.
  - **Fine-tuned — `htdemucs_ft`**: ~1 GB weights (4 models, one per source),
    ~4x slower on CPU, better separation.
  - First use of either downloads its weights once; needs network.

## Configuration (optional)

Copy `.env.example` to `.env`:

```sh
cp .env.example .env
```

- `HF_TOKEN` — Hugging Face read token. Silences the "unauthenticated requests
  to the HF Hub" warning and raises the download rate limit.
- `STEM_PLAYER_PYTHON` — force a specific Python interpreter.

`.env` is loaded by the Electron main process (via `dotenv`) and the values are
inherited by the Python subprocess. `.env` is gitignored.

## Install

```sh
npm install
```

## Run (development)

```sh
npm run dev
```

This starts the Next.js dev server on :3001 and launches Electron pointed at it.

## Run (from static export)

```sh
npm start
```

Builds the Next.js static export into `out/` and launches Electron against it.

## Requirements for making stems

Making stems needs a Mac with Apple silicon (M-series). Other Macs can still open
existing stems; wider support is planned for the web version.

## GPU or CPU

The menu offers **Processor: GPU / CPU**, with the GPU selected wherever this
Mac's GPU can run Demucs; it was about 40% faster on Fast in testing, with no
change in the stems. If a GPU run fails (for example, out of memory on a long
song), it starts over on the CPU automatically. Your choice is remembered, and
both processors share one cache.

## Where stems go

Separated songs go in a private cache at `<userData>/stem-cache`, so there are no
folders to manage. A song is recognised by its audio, not its filename, and Fast
and Best are stored separately, so opening a song you've already separated is
instant. The oldest songs are deleted once the cache passes 2 GB.

**Export Stems…** is the only thing that writes anywhere else. It copies a song's 4
WAVs into a new folder, and never replaces an existing one:

```
<chosen folder>/
  mysong/
    vocals.wav
    drums.wav
    bass.wav
    instrumental.wav
```

## Test it — separation (Phase 1)

1. Launch with `npm run dev` and open the hamburger menu.
2. Click **Choose…** next to **Song** and pick an audio file (mp3, wav, flac, m4a, mp4). If
   it's already separated at this quality, it opens straight away.
3. (Optional) Change the **Quality**.
4. Click **Separate**. Progress shows in the menu and under the device, so you can
   close the menu while it runs.
5. On success the menu closes and the 4 stems load into the mixer. The song is now
   under **Recent**.

## Test it — mixer (Phase 2)

- After a separation the stems auto-load. **Recent** reopens one instantly.
  **Open Stems Folder…** loads any folder that contains
  `vocals/drums/bass/instrumental.wav` (a `stems/` subfolder or its parent both
  work; a legacy `other.wav` is accepted as the instrumental).
- All 4 stems stay sample-synced (scheduled off one shared start time). Drag the
  **seek bar** or click any **waveform** to scrub.

## The device (Phase 3)

| Part | Action |
| --- | --- |
| Grooves | Drag for stem volume, click to mute. Hold the outer end to hear a stem alone until you let go, as on the hardware; double-click or Option-click anywhere for a solo that stays on. Vocals top, drums right, instrumental bottom, bass left. |
| Centre button | Play / pause |
| − / + pill | Master volume |
| Dot pill | Jump 10 seconds back / forward |
| Plain pill | Open or close the menu |

The hamburger in the top-left opens the same menu, which holds the source, output
folder, model and waveforms. It opens over the device without moving it, so you
can keep mixing with it open.

The device starts head-on. Press and drag to turn it, and it stays where you let
go. Double-click the background to bring it back. Where a press starts decides what
it does: on a groove it sets that stem's level, and anywhere else it turns the
device. Head-on, the edge buttons sit on the outline, so turn the device to reach
them comfortably. Every part also has a keyboard equivalent, which appears when
focused.

The model is generated by a script, so to change it, edit the script and rerun:

```sh
blender -b -P blender/build_stem_player.py
```

That writes `assets/models/stem-player.glb`, which the main process reads over
IPC in both dev and packaged runs. Part names in the script are a contract with
`lib/deviceScene.js`.

Stem audio is read over IPC and decoded in the renderer — ~4 decoded buffers
in memory (a few hundred MB for a full track).

Errors (bad/corrupt file, unsupported format, subprocess crash) show a generic
failure message in the UI; the real error is logged to the Electron console
(the terminal running `npm run dev`, and the detached DevTools).

## Tests

```sh
npm test                    # unit tests: groove gestures, stem cache, recommendations
npm run test:e2e            # the real app, driven with real input (needs ffmpeg + Demucs)
npm run test:e2e:gpu-fail   # the same, with every GPU run failing, to prove the CPU fallback
```

The end-to-end suite builds the static export, launches Electron against it with
throwaway app data in a temp folder, and prints where its screenshots went.

[Demucs]: https://github.com/adefossez/demucs
