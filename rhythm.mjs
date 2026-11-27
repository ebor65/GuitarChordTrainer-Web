import { chords, guitarStrings } from "./music.mjs";

export const beats = ["1", "&", "2", "&", "3", "&", "4", "&"];
export const strokes = { D: "↓", U: "↑", "-": "–" };
export const presets = {
  "Even downstrokes": [4, "D-D-D-D-", 80],
  "Folk strum": [4, "D-DU-UDU", 84],
  "Waltz": [3, "D-D-DU", 72],
  "Waltz upstrokes": [3, "D-UD-U", 72],
};
export const clampBpm = (bpm) => Math.min(150, Math.max(40, Math.round(bpm)));
export const validBpm = (bpm) => Number.isInteger(bpm) && bpm === clampBpm(bpm);

export function readPattern(text, meter) {
  const pattern = text.toUpperCase().replace(/\s+/g, "");
  if (pattern.length !== meter * 2 || /[^DU-]/.test(pattern)) {
    throw new Error(`Enter ${meter * 2} slots using D, U, and -.`);
  }
  return pattern;
}

export function resizePattern(text, meter) {
  return text.toUpperCase().replace(/\s+/g, "").replace(/[^DU-]/g, "-").slice(0, meter * 2).padEnd(meter * 2, "-");
}

export function slotLabel(slot, size) {
  return `${Math.floor(slot / size) + 1}.${Math.floor((slot % size) / 2) + 1}${slot % 2 ? "&" : ""}`;
}

export function arrangement(pattern, changes) {
  const slots = (Math.floor(changes.at(-1).slot / pattern.length) + 1) * pattern.length;
  return { pattern, changes, slots };
}

function rowAt(changes, slot) {
  let low = 0;
  let high = changes.length;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (changes[middle].slot <= slot) low = middle;
    else high = middle;
  }
  return low;
}

// A pulse carries its audio-clock time, stroke, and chord independently of input or UI.
export class RhythmTimeline {
  constructor(song, from, to, loop, countIn) {
    Object.assign(this, { song, from, to, loop });
    this.first = countIn ? -song.pattern.length : 0;
  }

  pulse(index, time) {
    const { song, from, to, loop } = this;
    const length = to - from;
    if (index < this.first || (!loop && index >= length)) return null;
    const countIn = index < 0;
    const slot = countIn ? index + song.pattern.length : from + index % length;
    const beat = slot % song.pattern.length;
    const row = rowAt(song.changes, countIn ? from : slot);
    const next = song.changes[row + 1];
    const nextChord = next && next.slot < to ? next.chord : loop ? song.changes[rowAt(song.changes, from)].chord : null;
    return {
      time, index, countIn, slot, beat, row, chord: song.changes[row].chord, nextChord,
      stroke: countIn ? "-" : song.pattern[beat],
    };
  }
}

// Scheduling is anchored to AudioContext time. Timer callbacks only refill the lookahead.
export class RhythmClock {
  constructor(timeline, time, bpm) {
    Object.assign(this, { timeline, time, bpm, phase: timeline.first, paused: false, next: timeline.first });
    this.previous = [];
  }

  at(time) {
    return this.phase + (this.paused ? 0 : (time - this.time) * this.bpm / 30);
  }

  retime(time, bpm, paused, resumeDelay = 0.04) {
    const phase = this.at(time);
    this.previous.push({ until: time, time: this.time, phase: this.phase, bpm: this.bpm, paused: this.paused });
    const beforeStart = time < this.time && !this.paused;
    this.phase = Math.max(this.timeline.first, phase);
    this.time = paused ? time : beforeStart ? this.time : time + (this.paused ? resumeDelay : 0);
    // A pulse exactly at the cut belongs to the new segment.
    this.next = Math.ceil(this.phase);
    this.bpm = bpm;
    this.paused = paused;
  }

  presentation(time) {
    while (this.previous[0]?.until <= time) this.previous.shift();
    const segment = this.previous[0] ?? this;
    const phase = segment.phase + (segment.paused ? 0 : (time - segment.time) * segment.bpm / 30);
    const index = Math.floor(phase);
    return {
      phase, paused: segment.paused,
      pulse: this.timeline.pulse(index, segment.time + (index - segment.phase) * 30 / segment.bpm),
    };
  }

  schedule(now, horizon, emit) {
    if (this.paused) return;
    this.next = Math.max(this.next, Math.ceil(this.at(now)));
    for (;;) {
      const time = this.time + (this.next - this.phase) * 30 / this.bpm;
      if (time > horizon) return;
      const pulse = this.timeline.pulse(this.next, time);
      if (!pulse) return;
      emit(pulse);
      this.next++;
    }
  }
}

const stringNames = ["e2", "a2", "d3", "g3", "b3", "e4"];
const strokeSpacing = {
  D: [0, 0.008, 0.015, 0.021, 0.026, 0.030],
  U: [0, 0.005, 0.009, 0.013, 0.017, 0.021],
};

export function guitarSamplePaths(chord, stroke) {
  if (chord === "Muted strings") return [stroke === "D" ? "muted-1.wav" : "muted-2.wav"];
  const strings = [...chords[chord][1]].flatMap((fret, index) => fret === "x" ? [] :
    [`meta-steel/${stringNames[index]}-${fret}-${stroke.toLowerCase()}.wav`]);
  return stroke === "U" ? strings.reverse() : strings;
}

export class RhythmAudio {
  constructor(context, synthesized = false) {
    this.synthesized = synthesized;
    this.context = context;
    this.sources = new Map();
    this.buffers = new Map();
    this.samples = new Map();
    this.guitarUntil = 0;
    this.click = context.createGain();
    this.guitar = context.createGain();
    this.click.connect(context.destination);
    this.guitar.connect(context.destination);
  }

  mix({ click, volume, guitar }) {
    this.click.gain.value = click ? volume : 0;
    this.guitar.gain.value = guitar ? 1 : 0;
  }

  sound(key, duration, sample) {
    if (!this.buffers.has(key)) {
      const rate = this.context.sampleRate;
      const buffer = this.context.createBuffer(1, Math.ceil(duration * rate), rate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = sample(i / rate);
      this.buffers.set(key, buffer);
    }
    return this.buffers.get(key);
  }

  queue(buffer, bus, time) {
    const node = this.context.createBufferSource();
    node.buffer = buffer;
    node.connect(bus);
    this.sources.set(node, { time, bus });
    if (bus === this.guitar) this.guitarUntil = Math.max(this.guitarUntil, time + buffer.duration);
    node.onended = () => { this.sources.delete(node); node.disconnect(); };
    node.start(time);
  }

  cancel(now, includePlaying) {
    this.guitarUntil = 0;
    for (const [node, { time, bus }] of this.sources) {
      if (includePlaying || time >= now) {
        node.stop();
        this.sources.delete(node);
      } else if (bus === this.guitar) {
        this.guitarUntil = Math.max(this.guitarUntil, time + node.buffer.duration);
      }
    }
  }

  async prepare(song, signal) {
    this.clickBuffer(true);
    this.clickBuffer(false);
    const voices = [];
    for (const chord of new Set(song.changes.map((change) => change.chord))) {
      for (const stroke of new Set(song.pattern)) {
        if (stroke === "-") continue;
        if (this.synthesized) this.synthesizeGuitar(chord, stroke);
        else voices.push(this.prepareGuitar(chord, stroke, signal));
      }
    }
    await Promise.all(voices);
  }

  clickBuffer(accent) {
    return this.sound(`click-${accent}`, 0.055, (t) =>
      (accent ? 0.38 : 0.25) * Math.sin(2 * Math.PI * (accent ? 1500 : 970) * t) * Math.exp(-85 * t));
  }

  synthesizeGuitar(chord, stroke) {
    const muted = chord === "Muted strings";
    const notes = muted ? [45, 46, 47, 48, 49, 50] :
      [...chords[chord][1]].flatMap((fret, index) =>
        fret === "x" ? [] : [guitarStrings[index][1] + Number(fret)]);
    if (stroke === "U") notes.reverse();
    const frequencies = notes.map(note => 2 * Math.PI * 440 * 2 ** ((note - 69) / 12));
    this.sound(`${chord}-${stroke}`, 0.19, (t) => frequencies.reduce((sum, frequency, index) => {
      const age = t - index * 0.004;
      if (age < 0) return sum;
      const angle = frequency * age;
      return sum + (Math.sin(angle) + 0.4 * Math.sin((muted ? 7 : 2) * angle)) *
        (1 - Math.exp(-1200 * age)) * Math.exp(-(muted ? 105 : 20) * age) * 0.052;
    }, 0));
  }

  sample(path, signal) {
    if (!this.samples.has(path)) {
      const url = new URL(`./assets/guitar/${path}`, import.meta.url);
      const decoded = fetch(url, { signal }).then((response) => {
        if (!response.ok) throw new Error(`Could not load guitar sample ${path}.`);
        return response.arrayBuffer();
      }).then((data) => this.context.decodeAudioData(data));
      this.samples.set(path, decoded);
    }
    return this.samples.get(path);
  }

  async prepareGuitar(chord, stroke, signal) {
    const notes = await Promise.all(guitarSamplePaths(chord, stroke).map((path) => this.sample(path, signal)));
    if (signal.aborted) return;
    const rate = this.context.sampleRate;
    const muted = chord === "Muted strings";
    const starts = notes.map((_, index) => Math.round(strokeSpacing[stroke][index] * rate));
    const length = Math.max(...notes.map((note, index) => starts[index] + note.length));
    const buffer = this.context.createBuffer(1, length, rate);
    const output = buffer.getChannelData(0);
    const strength = muted ? 0.72 : stroke === "D" ? 0.48 : 0.37;
    notes.forEach((note, index) => {
      const samples = note.getChannelData(0);
      const gain = strength * (1 - 0.045 * index);
      const start = starts[index];
      for (let i = 0; i < samples.length; i++) output[start + i] += samples[i] * gain;
    });
    let peak = 0;
    for (let i = 0; i < output.length; i++) {
      if (!muted) output[i] *= Math.exp(-2.8 * i / rate);
      peak = Math.max(peak, Math.abs(output[i]));
    }
    if (!muted && peak > 0.38) {
      for (let i = 0; i < output.length; i++) output[i] *= 0.38 / peak;
    }
    this.buffers.set(`${chord}-${stroke}`, buffer);
  }

  play({ time, beat, stroke, chord }) {
    if (beat % 2 === 0) this.queue(this.clickBuffer(beat === 0), this.click, time);
    if (stroke !== "-") this.queue(this.buffers.get(`${chord}-${stroke}`), this.guitar, time);
  }
}
