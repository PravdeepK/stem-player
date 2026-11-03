import { useEffect, useRef } from "react";
import { beat } from "../lib/haptics";
import { STEM_BAND_HZ, createBeatClock, findBeats, tapSource } from "../lib/beatTaps";

// rAF notices a crossed beat up to a frame late, and the tap then hops over
// IPC to the main process; leading by about that much evens it out.
const TAP_LEAD_S = 0.01;

const NONE = { times: [], strengths: [] };

// Beats per decoded stem. Keyed by the AudioBuffer itself, so a new song
// (new buffers) never sees the old one's beats and nothing has to be cleared.
const beatCache = new WeakMap();

function beatsOf(buffer, stem) {
  let beats = beatCache.get(buffer);
  if (!beats) {
    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    beats = findBeats(channels, buffer.sampleRate, { lowpassHz: STEM_BAND_HZ[stem] });
    beatCache.set(buffer, beats);
  }
  return beats;
}

/**
 * Taps the trackpad on the beat while `enabled` and a song plays. Follows the
 * drums, or a soloed stem when the drums aren't heard (lib/beatTaps.js), and
 * fires when the playhead the listener *hears* — the audio clock minus the
 * output latency — crosses a beat. Turning the volume down (the master, or
 * the followed stem's own) lets only the harder hits through.
 */
export function useBeatTaps(mixer, enabled) {
  const { buffers, settings, masterVolume, onLevels, getPosition, getOutputLatency } = mixer;
  const mixRef = useRef({ buffers, settings, masterVolume });

  useEffect(() => {
    mixRef.current = { buffers, settings, masterVolume };
  }, [buffers, settings, masterVolume]);

  // Find a new song's beats ahead of playback, drums first, one stem per task
  // so none of them holds up a frame for long.
  useEffect(() => {
    if (!enabled || !buffers) return undefined;
    const queue = ["drums", "bass", "instrumental", "vocals"];
    let id = 0;
    const next = () => {
      const stem = queue.shift();
      if (!stem) return;
      if (buffers[stem]) beatsOf(buffers[stem], stem);
      id = setTimeout(next, 0);
    };
    id = setTimeout(next, 0);
    return () => clearTimeout(id);
  }, [buffers, enabled]);

  // onLevels runs once a frame while playing and once on stop: the clock we want.
  useEffect(() => {
    if (!enabled) return undefined;
    const clock = createBeatClock();
    return onLevels((_levels, stopped) => {
      if (stopped) {
        clock.reset();
        return;
      }
      const { buffers: bufs, settings: s, masterVolume: mv } = mixRef.current;
      const source = tapSource(s, mv);
      const buffer = source && bufs && bufs[source.stem];
      // Advance even with nothing to follow, so switching back never taps
      // for beats that went by in the meantime.
      const heard = getPosition() - getOutputLatency() + TAP_LEAD_S;
      const beats = buffer ? beatsOf(buffer, source.stem) : NONE;
      if (clock.advance(beats, heard, buffer ? source.gain : 0)) beat();
    });
  }, [enabled, onLevels, getPosition, getOutputLatency]);
}
