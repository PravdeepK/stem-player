#!/usr/bin/env python3
"""Thin Demucs wrapper for the Stem Player app (Phase 1).

Usage:
    python separate.py <input_audio_path> <output_dir> [model] [device]

[model] is "htdemucs" (default) or "htdemucs_ft". [device] is "cpu" (default) or
"mps" for the Apple GPU; the caller retries on CPU if an "mps" run fails. Writes
4 stems (vocals, drums, bass, other) as WAV files into <output_dir>. Communicates with
the Electron main process over
stdout using newline-delimited JSON messages:

    {"type": "progress", "value": 0.0-1.0}
    {"type": "stage", "value": "model" | "separating"}
    {"type": "done", "stems": {"vocals": "...", "drums": "...", "bass": "...", "other": "..."}}
    {"type": "error", "message": "..."}

A "model" stage means the model's weights are downloading (its first use), and
progress then follows the download. "separating" comes once the model is loaded,
and progress restarts at 0 for the song. An error with "code": "model" means the
model couldn't be fetched or loaded, which no other device would fix.

On error it also exits with a non-zero status. Human-readable diagnostics go to
stderr so the Electron side can log them to the console.
"""

import json
import os
import stat
import sys
import threading
import traceback

_emit_lock = threading.Lock()


def emit(obj):
    """Write one JSON message to stdout and flush immediately."""
    with _emit_lock:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()


def log(*args):
    print(*args, file=sys.stderr, flush=True)


ALLOWED_MODELS = {"htdemucs", "htdemucs_ft"}
ALLOWED_DEVICES = {"cpu", "mps"}

# The first use of each model downloads its weights from the Hugging Face hub
# inside Separator(), which says nothing meanwhile: one 84 MB file for htdemucs,
# four for htdemucs_ft. The bytes arriving in the hub cache stand in for it.
MODEL_REPOS = {
    "htdemucs": "models--adefossez--HTDemucs",
    "htdemucs_ft": "models--adefossez--HTDemucs-ft",
}
MODEL_BYTES = {"htdemucs": 84_025_440, "htdemucs_ft": 4 * 84_025_440}


def folder_bytes(folder):
    """Total size of the regular files under a folder, without following links."""
    total = 0
    for root, _dirs, files in os.walk(folder):
        for name in files:
            try:
                info = os.lstat(os.path.join(root, name))
            except OSError:
                continue
            if stat.S_ISREG(info.st_mode):
                total += info.st_size
    return total


class WeightDownload:
    """Reports a model's weights downloading, if they are, while the block runs."""

    def __init__(self, model_name):
        from huggingface_hub import constants

        self.folder = os.path.join(constants.HF_HUB_CACHE, MODEL_REPOS[model_name])
        self.expected = MODEL_BYTES[model_name]
        self.baseline = folder_bytes(self.folder)
        self.downloading = False
        self.shown = None
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.watch, daemon=True)

    def watch(self):
        while not self.stop.wait(0.5):
            got = folder_bytes(self.folder) - self.baseline
            # The bag's yaml is a few hundred bytes; only the weights count.
            if got < 1_000_000:
                continue
            if not self.downloading:
                self.downloading = True
                emit({"type": "stage", "value": "model"})
            value = round(min(0.99, got / self.expected), 4)
            if value != self.shown:
                self.shown = value
                emit({"type": "progress", "value": value})

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_exc):
        self.stop.set()
        self.thread.join()


def main():
    if len(sys.argv) not in (3, 4, 5):
        emit({"type": "error", "message": "expected <input> <output_dir> [model] [device]"})
        return 2

    input_path = os.path.abspath(sys.argv[1])
    output_dir = os.path.abspath(sys.argv[2])
    model_name = sys.argv[3] if len(sys.argv) >= 4 else "htdemucs"
    if model_name not in ALLOWED_MODELS:
        emit({"type": "error", "message": f"unknown model: {model_name}"})
        return 2
    device = sys.argv[4] if len(sys.argv) == 5 else "cpu"
    if device not in ALLOWED_DEVICES:
        emit({"type": "error", "message": f"unknown device: {device}"})
        return 2

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
    # segment_offset, state ("start"/"end"). htdemucs_ft is a 4-model bag (one
    # fine-tuned model per source), so progress spans model_idx 0..3.
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

    # Separator() only fetches and loads the weights, on the CPU whatever the
    # device, so a failure here is the network or the download, never the GPU.
    try:
        with WeightDownload(model_name):
            separator = Separator(
                model=model_name,
                device=device,
                progress=False,
                callback=callback,
            )
    except Exception as exc:
        log("failed to construct Separator:", repr(exc))
        log(traceback.format_exc())
        emit({"type": "error", "code": "model", "message": f"could not load the {model_name} model"})
        return 1

    emit({"type": "stage", "value": "separating"})
    emit({"type": "progress", "value": 0.0})

    try:
        _origin, stems = separator.separate_audio_file(input_path)
    except Exception as exc:
        log("separation failed:", repr(exc))
        log(traceback.format_exc())
        emit({"type": "error", "message": "audio separation failed (invalid or unsupported file?)"})
        return 1

    # The 4 stem WAVs are written straight into output_dir (the caller decides
    # the folder layout). Demucs' "other" stem is exposed as "instrumental".
    rename = {"other": "instrumental"}
    written = {}
    try:
        for name, source in stems.items():
            out_name = rename.get(name, name)
            out_path = os.path.join(output_dir, f"{out_name}.wav")
            save_audio(source, out_path, samplerate=separator.samplerate)
            written[out_name] = out_path
    except Exception as exc:
        log("failed to write stems:", repr(exc))
        log(traceback.format_exc())
        emit({"type": "error", "message": "failed to write stem files to disk"})
        return 1

    expected = {"vocals", "drums", "bass", "instrumental"}
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
