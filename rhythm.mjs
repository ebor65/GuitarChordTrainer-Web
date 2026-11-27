import { chords, guitarStrings } from "./music.mjs";

const legacyMeters = { 2: "2/4", 3: "3/4", 4: "4/4", 6: "6/8" };
const namedMeters = ["5/4", "7/4", "3/8", "9/8", "12/8", "7/8"];
const subdivisions = ["quarter", "straight", "triplet", "sixteenth", "swing"];
export const supportedMeters = "2/4, 3/4, 4/4, 6/8, 5/4, 7/4, 3/8, 9/8, 12/8, 7/8, or N/D (N 1–32, D 1, 2, 4, 8, 16, or 32)";

export function meterKey(value) {
  const name = Object.hasOwn(legacyMeters, value) ? legacyMeters[value] : value;
  const match = /^([1-9][0-9]?)\/(1|2|4|8|16|32)$/.exec(name);
  if (!match || Number(match[1]) > 32) return null;
  const legacy = Object.keys(legacyMeters).find(key => legacyMeters[key] === name);
  return legacy === undefined ? name : Number(legacy);
}

function meterSettings(meter) {
  const name = legacyMeters[meter] ?? meter;
  const [numerator, denominator] = name.split("/").map(Number);
  const compound = denominator === 8 && numerator >= 6 && numerator % 3 === 0;
  return { name, compound, beats: compound ? numerator / 3 : numerator,
    length: (compound ? 3 : 1) / denominator,
    unit: compound ? "Dotted-quarter beats" : ({
      1: "Whole-note beats", 2: "Half-note beats", 4: "Quarter-note beats", 8: "Eighth-note beats",
      16: "Sixteenth-note beats", 32: "Thirty-second-note beats",
    })[denominator] };
}

export function gridOptions(meter) {
  const { name, compound, beats, length, unit } = meterSettings(meter);
  const base = compound ? "compound" : length >= 1 / 8 ? "straight" : length >= 1 / 16 ? "sixteenth" : "beat";
  const counts = { quarter: length * 4, straight: length * 8, compound: 3, triplet: 3,
    sixteenth: length * 16, swing: length * 8, beat: 1 };
  const available = new Set([base, ...subdivisions]);
  if (compound) available.delete("straight");
  return [...available].flatMap(kind => {
    const subdivision = counts[kind];
    if (!Number.isInteger(subdivision) || subdivision < 1 || (kind === "swing" && subdivision % 2)) return [];
    const labels = Array.from({ length: beats * subdivision }, (_, index) => {
      const offset = index % subdivision;
      if (kind === "compound") return String(index + 1);
      if (!offset) return String(Math.floor(index / subdivision) + 1);
      if (subdivision === 2) return "&";
      if (kind === "triplet") return offset === 1 ? "trip" : "let";
      return String(offset + 1);
    });
    return [{ name, kind, labels, subdivision, unit }];
  });
}

const gridCache = new Map();
export function meterGrid(meter, kind) {
  if (!gridCache.has(meter)) gridCache.set(meter, gridOptions(meter));
  const choices = gridCache.get(meter);
  return choices.find(option => option.kind === kind) ?? choices[0];
}

export const meters = Object.fromEntries([...Object.keys(legacyMeters), ...namedMeters].map(key => [key, meterGrid(key)]));

export const strokes = { X: "×", D: "↓", U: "↑", "-": "–" };
export const presets = {
  "Even downstrokes": [4, "D-D-D-D-", 80],
  "Folk strum": [4, "D-DU-UDU", 84],
  "Waltz": [3, "D-D-DU", 72],
  "Waltz upstrokes": [3, "D-UD-U", 72],
  "2/4 Basic": [2, "D-D-", 60],
  "6/8 Basic": [6, "D--D--", 60],
};
export const clampBpm = (bpm) => Math.min(150, Math.max(40, Math.round(bpm)));
export const validBpm = (bpm) => Number.isInteger(bpm) && bpm === clampBpm(bpm);

export function readPattern(text, meter, kind) {
  const slots = meterGrid(meter, kind).labels.length;
  const pattern = text.toUpperCase().replace(/\s+/g, "");
  if (pattern.length !== slots || /[^DUX-]/.test(pattern)) {
    throw new Error(`Enter ${slots} slots using D, U, X and -.`);
  }
  return pattern;
}

export function resizePattern(text, meter, kind) {
  const slots = meterGrid(meter, kind).labels.length;
  return text.toUpperCase().replace(/\s+/g, "").replace(/[^DUX-]/g, "-").slice(0, slots).padEnd(slots, "-");
}

export function slotLabel(slot, size, subdivision = 2) {
  const offset = slot % subdivision;
  const beat = Math.floor((slot % size) / subdivision) + 1;
  const suffix = offset === 0 ? "" : subdivision === 2 ? "&" : `.${offset + 1}`;
  return `${Math.floor(slot / size) + 1}.${beat}${suffix}`;
}

export function arrangement(pattern, changes, meter, { kind, endSlot, restart = false } = {}) {
  const grid = meterGrid(meter, kind);
  const barSlots = grid.labels.length;
  const slots = endSlot ?? (Math.floor(changes.at(-1).slot / barSlots) + 1) * barSlots;
  return { pattern, changes, slots, barSlots, meter, kind: grid.kind, grid, restart };
}

export function strokeAt(song, slot, row = rowAt(song.changes, slot)) {
  const change = song.changes[row];
  const offset = slot - change.slot;
  if (change.localPattern) return change.localPattern[offset] ?? "-";
  return song.pattern[(song.restart ? offset : slot) % song.pattern.length];
}

// Logical slots stay integers. Swing maps each offbeat onto two thirds of its pair.
function swingPosition(position, length, inverse) {
  const pair = Math.floor(position / length);
  const offset = position - pair * length;
  const split = inverse ? 2 / 3 : 1 / 2;
  const target = inverse ? 1 / 2 : 2 / 3;
  const fraction = offset / length;
  return pair + (fraction < split ? fraction * target / split :
    target + (fraction - split) * (1 - target) / (1 - split));
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
    this.subdivision = song.grid.subdivision;
    this.first = countIn ? -song.barSlots : 0;
    this.swing = song.kind === "swing";
    this.origin = this.sourceBeat(from);
    this.cycle = this.sourceBeat(to) - this.origin;
  }

  sourceBeat(slot) {
    return this.swing ? swingPosition(slot, 2, false) * 2 / this.subdivision : slot / this.subdivision;
  }

  beatAt(index) {
    if (!this.swing || index < 0) return this.sourceBeat(index);
    const length = this.to - this.from;
    const cycle = Math.floor(index / length);
    return cycle * this.cycle + this.sourceBeat(this.from + index - cycle * length) - this.origin;
  }

  indexAt(beat) {
    if (!this.swing) return beat * this.subdivision;
    if (beat < 0) return swingPosition(beat * this.subdivision / 2, 1, true) * 2;
    const cycle = Math.floor(beat / this.cycle);
    const position = this.origin + beat - cycle * this.cycle;
    return cycle * (this.to - this.from) + swingPosition(position * this.subdivision / 2, 1, true) * 2 - this.from;
  }

  pulse(index, time) {
    const { song, from, to, loop } = this;
    const length = to - from;
    if (index < this.first || (!loop && index >= length)) return null;
    const countIn = index < 0;
    const slot = countIn ? index + song.barSlots : from + index % length;
    const beat = slot % song.barSlots;
    const row = rowAt(song.changes, countIn ? from : slot);
    const next = song.changes[row + 1];
    const nextChord = next && next.slot < to ? next.chord : loop ? song.changes[rowAt(song.changes, from)].chord : null;
    return {
      time, index, countIn, slot, beat, mainBeat: beat % this.subdivision === 0, row, chord: song.changes[row].chord, nextChord,
      stroke: countIn ? "-" : strokeAt(song, slot, row),
      duration: (next?.slot ?? song.slots) - song.changes[row].slot,
      remaining: (next?.slot ?? song.slots) - slot,
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
    return this.phaseAt(this, time);
  }

  phaseAt(segment, time) {
    return segment.paused ? segment.phase : this.timeline.indexAt(
      this.timeline.beatAt(segment.phase) + (time - segment.time) * segment.bpm / 60);
  }

  onset(segment, index) {
    return segment.time + (this.timeline.beatAt(index) - this.timeline.beatAt(segment.phase)) * 60 / segment.bpm;
  }

  retime(time, bpm, paused, resumeDelay = 0.04, target) {
    const phase = target ?? this.at(time);
    this.previous.push({ until: time, time: this.time, phase: this.phase, bpm: this.bpm, paused: this.paused });
    const beforeStart = target === undefined && time < this.time && !this.paused;
    this.phase = Math.max(this.timeline.first, phase);
    this.time = paused ? time : beforeStart ? this.time : time + (this.paused || target !== undefined ? resumeDelay : 0);
    // A pulse exactly at the cut belongs to the new segment.
    this.next = Math.ceil(this.phase);
    this.bpm = bpm;
    this.paused = paused;
  }

  presentation(time) {
    while (this.previous[0]?.until <= time) this.previous.shift();
    const segment = this.previous[0] ?? this;
    const phase = this.phaseAt(segment, time);
    const index = Math.floor(phase);
    return {
      phase, paused: segment.paused,
      pulse: this.timeline.pulse(index, this.onset(segment, index)),
    };
  }

  schedule(now, horizon, emit) {
    if (this.paused) return;
    this.next = Math.max(this.next, Math.ceil(this.at(now)));
    for (;;) {
      const time = this.onset(this, this.next);
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
    const byChord = new Map();
    for (const { chord, localPattern } of song.changes) {
      for (const stroke of new Set(localPattern ?? song.pattern)) {
        if (stroke === "-") continue;
        const key = stroke === "X" ? "Muted strings" : chord;
        if (!byChord.has(key)) byChord.set(key, new Set());
        byChord.get(key).add(stroke === "X" ? "D" : stroke);
      }
    }
    for (const [chord, strokes] of byChord) {
      for (const stroke of strokes) {
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

  play({ time, beat, mainBeat, stroke, chord }) {
    if (mainBeat) this.queue(this.clickBuffer(beat === 0), this.click, time);
    if (stroke === "X") this.queue(this.buffers.get("Muted strings-D"), this.guitar, time);
    else if (stroke !== "-") this.queue(this.buffers.get(`${chord}-${stroke}`), this.guitar, time);
  }
}
