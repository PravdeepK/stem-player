#!/usr/bin/env python3
"""Thin Demucs wrapper for the Stem Player app (Phase 1).

Usage:
    python separate.py <input_audio_path> <output_dir>

Runs the `htdemucs` model on CPU and writes 4 stems (vocals, drums, bass, other)
as WAV files into <output_dir>. Communicates with the Electron main process over
stdout using newline-delimited JSON messages:

    {"type": "progress", "value": 0.0-1.0}
    {"type": "done", "stems": {"vocals": "...", "drums": "...", "bass": "...", "other": "..."}}
    {"type": "error", "message": "..."}

On error it also exits with a non-zero status. Human-readable diagnostics go to
stderr so the Electron side can log them to the console.
"""

import json
import os
import sys
import traceback


def emit(obj):
    """Write one JSON message to stdout and flush immediately."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def log(*args):
    print(*args, file=sys.stderr, flush=True)


def main():
    if len(sys.argv) != 3:
        emit({"type": "error", "message": "expected exactly 2 arguments: <input> <output_dir>"})
        return 2

    input_path = os.path.abspath(sys.argv[1])
    output_dir = os.path.abspath(sys.argv[2])

    if not os.path.isfile(input_path):
        emit({"type": "error", "message": f"input file not found: {input_path}"})
        return 1

    os.makedirs(output_dir, exist_ok=True)

    try:
        import torch  # noqa: F401  (imported for side effects / clearer error if missing)
        from demucs.api import Separator, save_audio
    except Exception as exc:  # pragma: no cover - environment problem
        log("failed to import demucs:", repr(exc))
        log(traceback.format_exc())
        emit({
            "type": "error",
            "message": "demucs is not installed for this Python interpreter",
        })
        return 1

    emit({"type": "progress", "value": 0.0})

    # --- progress plumbing --------------------------------------------------
    # The Demucs callback dict carries: model_idx_in_bag, models, audio_length,
    # segment_offset, state ("start"/"end"). htdemucs is a single-model bag, so
    # this reduces to how far through the audio we are.
    state = {"last": 0.0}

    def callback(data):
        try:
            if data.get("state") != "end":
                return
            models = max(1, int(data.get("models", 1)))
            model_idx = int(data.get("model_idx_in_bag", 0))
            audio_length = max(1, int(data.get("audio_length", 1)))
            seg_off = int(data.get("segment_offset", 0))
            frac = (model_idx + min(1.0, seg_off / audio_length)) / models
            # Reserve the last 5% for writing files to disk.
            frac = max(0.0, min(0.95, frac * 0.95))
            if frac > state["last"]:
                state["last"] = frac
                emit({"type": "progress", "value": round(frac, 4)})
        except Exception as exc:  # never let progress math kill the run
            log("progress callback error:", repr(exc))

    try:
        separator = Separator(
            model="htdemucs",
            device="cpu",
            progress=False,
            callback=callback,
        )
    except Exception as exc:
        log("failed to construct Separator:", repr(exc))
        log(traceback.format_exc())
        emit({"type": "error", "message": "could not load the htdemucs model"})
        return 1

    try:
        _origin, stems = separator.separate_audio_file(input_path)
    except Exception as exc:
        log("separation failed:", repr(exc))
        log(traceback.format_exc())
        emit({"type": "error", "message": "audio separation failed (invalid or unsupported file?)"})
        return 1

    # The 4 stem WAVs are written straight into output_dir (the caller decides
    # the folder layout).
    written = {}
    try:
        for name, source in stems.items():
            out_path = os.path.join(output_dir, f"{name}.wav")
            save_audio(source, out_path, samplerate=separator.samplerate)
            written[name] = out_path
    except Exception as exc:
        log("failed to write stems:", repr(exc))
        log(traceback.format_exc())
        emit({"type": "error", "message": "failed to write stem files to disk"})
        return 1

    expected = {"vocals", "drums", "bass", "other"}
    missing = expected - set(written)
    if missing:
        log("missing expected stems:", missing, "got:", set(written))
        emit({"type": "error", "message": f"separation produced incomplete output (missing: {sorted(missing)})"})
        return 1

    emit({"type": "progress", "value": 1.0})
    emit({"type": "done", "stems": written})
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        emit({"type": "error", "message": "cancelled"})
        sys.exit(130)
    except Exception as exc:  # last-resort catch-all
        log("unexpected error:", repr(exc))
        log(traceback.format_exc())
        emit({"type": "error", "message": "unexpected error in separation process"})
        sys.exit(1)
