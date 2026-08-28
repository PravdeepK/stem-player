# Stem Player — Phase 1 (separation pipeline only)

Personal, non-commercial Electron app. Loads a local audio file and splits it
into 4 stems (vocals, drums, bass, other) with [Demucs] (`htdemucs`, CPU-only).

No mixer, no playback UI — that's a later phase.

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

- First separation downloads the `htdemucs` weights (~80 MB) once; needs network.

## Install

```sh
npm install
```

## Run (development)

```sh
npm run dev
```

This starts the Next.js dev server on :3000 and launches Electron pointed at it.

## Run (from static export)

```sh
npm start
```

Builds the Next.js static export into `out/` and launches Electron against it.

## Output layout

You choose a base folder (remembered between runs in
`<userData>/config.json`; the picker also opens on every run so you can
redirect). For a file `mysong.mp3` and base `~/Music/stems`:

```
~/Music/stems/
  mysong/
    mysong.mp3          # copy of the original
    stems/
      vocals.wav
      drums.wav
      bass.wav
      other.wav
```

If `mysong/` already exists it becomes `mysong-2/`, `mysong-3/`, …

## Test it

1. Launch with `npm run dev`.
2. Click **Pick audio file…**, choose an `.mp3` or `.wav`.
3. (Optional) **Change…** the output folder.
4. Click **Separate**. Confirm/redirect the folder in the picker that opens.
   You'll see `Processing… N%`.
5. On success the UI shows **Done** with the song folder path (with a
   **Show in Finder** button) and the full stem + original paths.

Errors (bad/corrupt file, unsupported format, subprocess crash) show a generic
failure message in the UI; the real error is logged to the Electron console
(the terminal running `npm run dev`, and the detached DevTools).

[Demucs]: https://github.com/adefossez/demucs
