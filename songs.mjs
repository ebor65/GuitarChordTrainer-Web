import { chords, concatenate, recognizeChord } from "./music.mjs";

const defaultSong = `[G]Morning rolls across the hill
[C]Windows catch the light
[Em]I can hear the city waking
[D]After all the night
[G]Take the road beside the river
[C]Leave the rush behind
[Em]Let the open strings keep ringing
[D]One more bar in time
[G]Bring it home`;
const beatLabels = ["1", "&", "2", "&", "3", "&", "4", "&"];
const strokes = { D: "↓", U: "↑", "-": "–" };
const storageKey = "guitar-chord-trainer-song-v1";

function readAlignedBars(source) {
  const lines = source.split(/\r?\n/).filter((line) => line.trim());
  const chordSymbol = /^[A-G][#b]?(?:(?:maj|min|dim|aug|sus|add|m|M)?\d*|[+°])(?:\/[A-G][#b]?)?$/;
  const chordLine = (line) => line.trim().split(/\s+/).every((word) => chordSymbol.test(word));
  const bars = [];
  for (let index = 0; index < lines.length; index++) {
    if (!chordLine(lines[index])) {
      throw new Error("Put chords on a line above the lyrics, or start each bar with [G] or another chord.");
    }
    const names = [...lines[index].matchAll(/\S+/g)];
    const next = lines[index + 1];
    const lyrics = next && !chordLine(next) ? lines[++index] : "";
    names.forEach(([chord], column) => {
      const start = column === 0 ? 0 : names[column].index;
      bars.push({ chord, lyrics: lyrics.slice(start, names[column + 1]?.index).trim() });
    });
  }
  return bars;
}

function readInlineBars(source) {
  const markers = [...source.matchAll(/\[([^\[\]\r\n]+)\]/g)];
  if (!markers.length || source.slice(0, markers[0].index).trim()) {
    throw new Error("Start the sheet with a chord in brackets, such as [G].");
  }
  return markers.map(([marker, name], index) => {
    const lyrics = source.slice(markers[index].index + marker.length, markers[index + 1]?.index).trim();
    if (/[\[\]]/.test(lyrics)) throw new Error("Use matching brackets around each chord.");
    return { chord: name.trim(), lyrics };
  });
}

export function parseSong(source, tempo, strumming) {
  if (!Number.isInteger(tempo) || tempo < 40 || tempo > 150) {
    throw new Error("Choose a tempo between 40 and 150 BPM.");
  }

  const pattern = strumming.toUpperCase().replace(/\s+/g, "").split("");
  if (pattern.length !== beatLabels.length || pattern.some((stroke) => !Object.hasOwn(strokes, stroke)) ||
      pattern.every((stroke) => stroke === "-")) {
    throw new Error("Enter eight slots using D, U, and -, with at least one strum.");
  }

  const bars = /[\[\]]/.test(source) ? readInlineBars(source) : readAlignedBars(source);
  if (!bars.length) throw new Error("Enter a chord and lyric sheet.");
  const unsupported = bars.find(({ chord }) => !Object.hasOwn(chords, chord));
  if (unsupported) {
    throw new Error(`Chord ${unsupported.chord} is unavailable. Supported chords: ${Object.keys(chords).join(", ")}.`);
  }
  const slotSeconds = 30 / tempo;
  return { bars, pattern, slotSeconds, slots: bars.length * pattern.length };
}

export function timedSlot(song, elapsed) {
  const slot = Math.floor(elapsed / song.slotSeconds + 0.5);
  const tolerance = Math.min(0.12, song.slotSeconds * 0.4);
  if (slot < 0 || slot >= song.slots || song.pattern[slot % song.pattern.length] === "-" ||
      Math.abs(elapsed - slot * song.slotSeconds) > tolerance) return null;
  return slot;
}

export function createSongPractice(toggle) {
  const element = (id) => document.getElementById(`song-${id}`);
  const button = element("button");
  const message = element("message");
  const feedback = element("feedback");
  const position = element("position");
  const timing = element("timing");
  const matchedChords = element("chords");
  const source = element("source");
  const tempo = element("tempo");
  const pattern = element("pattern");
  const editor = source.closest("details");
  const sheet = element("sheet");
  const beats = element("beats");
  let rows = [];
  let pulses = [];
  let displayedBar = -1;
  let displayedPulse = -1;

  source.value = defaultSong;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (saved) {
      parseSong(saved.source, saved.tempo, saved.pattern);
      source.value = saved.source;
      tempo.value = saved.tempo;
      pattern.value = saved.pattern;
    }
  } catch {
    // Use the example when storage is unavailable or the saved chart is invalid.
  }

  function highlight(bar, pulse) {
    if (bar !== displayedBar) {
      rows[displayedBar]?.classList.remove("active");
      rows[displayedBar]?.removeAttribute("aria-current");
      displayedBar = bar;
      if (rows[bar]) {
        rows[bar].classList.add("active");
        rows[bar].setAttribute("aria-current", "true");
        sheet.scrollTop += rows[bar].getBoundingClientRect().top - sheet.getBoundingClientRect().top -
          (sheet.clientHeight - rows[bar].offsetHeight) / 2;
      }
    }
    if (pulse !== displayedPulse) {
      pulses[displayedPulse]?.classList.remove("active");
      pulses[pulse]?.classList.add("active");
      displayedPulse = pulse;
    }
  }

  function render(song) {
    highlight(-1, -1);
    rows = song.bars.map(({ chord, lyrics }) => {
      const row = document.createElement("li");
      const name = document.createElement("strong");
      name.textContent = chord;
      const line = document.createElement("span");
      line.textContent = lyrics;
      row.append(name, line);
      return row;
    });
    pulses = song.pattern.map((stroke, index) => {
      const pulse = document.createElement("span");
      pulse.className = "song-beat";
      pulse.setAttribute("aria-label", `${beatLabels[index]} ${{ D: "down", U: "up", "-": "rest" }[stroke]}`);
      const beat = document.createElement("small");
      beat.textContent = beatLabels[index];
      const direction = document.createElement("strong");
      direction.textContent = strokes[stroke];
      pulse.append(beat, direction);
      return pulse;
    });
    sheet.replaceChildren(...rows);
    sheet.scrollTop = 0;
    beats.replaceChildren(...pulses);
  }

  function read() {
    try {
      return parseSong(source.value, tempo.valueAsNumber, pattern.value);
    } catch (error) {
      message.textContent = error.message;
      return null;
    }
  }

  function setEditing(enabled) {
    for (const field of [source, tempo, pattern]) field.disabled = !enabled;
    if (!enabled) editor.open = false;
  }

  element("form").addEventListener("submit", (event) => {
    event.preventDefault();
    toggle("song");
  });
  for (const field of [source, tempo, pattern]) {
    field.addEventListener("change", () => {
      const song = read();
      if (!song) return;
      message.textContent = "";
      render(song);
      try {
        localStorage.setItem(storageKey, JSON.stringify({
          source: source.value, tempo: tempo.valueAsNumber, pattern: pattern.value,
        }));
      } catch {
        message.textContent = "This sheet could not be saved on this device.";
      }
    });
  }
  render(parseSong(source.value, tempo.valueAsNumber, pattern.value));

  function start(current, finish) {
    const song = current.song;
    render(song);
    Object.assign(current, {
      active: true, startsAt: current.context.currentTime + song.slotSeconds * song.pattern.length,
      previous: 0.001, floor: 0.001, lastStrum: -Infinity, blocks: [],
      onTime: new Set(), chordMatches: 0, detected: 0, offBeat: 0,
      expected: song.bars.length * song.pattern.filter((stroke) => stroke !== "-").length,
    });
    timing.textContent = `0 / ${current.expected}`;
    matchedChords.textContent = "0 / 0";
    feedback.textContent = "";
    let previousSlot;
    const tick = () => {
      const elapsed = current.context.currentTime - current.startsAt;
      const slot = Math.max(-song.pattern.length, Math.floor(elapsed / song.slotSeconds));
      if (slot >= song.slots) {
        if (elapsed >= (song.slots * song.slotSeconds) + 0.16) {
          finish(`Song complete. ${current.expected - current.onTime.size} missed, ${current.offBeat} off beat.`);
        }
        return;
      }
      if (slot === previousSlot) return;
      previousSlot = slot;
      const pulse = ((slot % song.pattern.length) + song.pattern.length) % song.pattern.length;
      if (slot < 0) {
        position.textContent = `Count in · ${beatLabels[pulse]}`;
        highlight(-1, pulse);
        message.textContent = "Get ready for the first bar.";
        return;
      }
      const bar = Math.floor(slot / song.pattern.length);
      position.textContent = `Bar ${bar + 1} of ${song.bars.length} · ${song.bars[bar].chord}`;
      highlight(bar, pulse);
      message.textContent = "";
      button.textContent = "Stop song";
    };
    tick();
    current.timer = setInterval(tick, 20);
  }

  function capture(current, samples, timestamp, level) {
    const { song, blocks } = current;
    const elapsed = timestamp - current.startsAt;
    const slot = timedSlot(song, elapsed);
    if (elapsed < 0 && slot === null) return;
    if (blocks.length) {
      blocks.push(samples);
      if (blocks.length === 6) {
        const heard = recognizeChord(concatenate(blocks.slice(1)), current.context.sampleRate);
        blocks.length = 0;
        current.detected++;
        if (heard === current.expectedChord) current.chordMatches++;
        matchedChords.textContent = `${current.chordMatches} / ${current.detected}`;
        feedback.textContent = `${current.strumTiming} · ${heard === current.expectedChord
          ? `${heard} matched` : `Expected ${current.expectedChord}. Heard ${heard ?? "an unclear chord"}.`}`;
      }
    } else if (elapsed < song.slots * song.slotSeconds && timestamp - current.lastStrum >= 0.12 &&
      level > Math.max(0.0025, 3 * current.floor, 1.5 * current.previous)) {
      const onTime = slot !== null && !current.onTime.has(slot);
      if (onTime) current.onTime.add(slot);
      else current.offBeat++;
      timing.textContent = `${current.onTime.size} / ${current.expected}`;
      const bar = Math.floor((slot ?? Math.max(0, Math.floor(elapsed / song.slotSeconds))) / song.pattern.length);
      current.expectedChord = song.bars[bar].chord;
      current.strumTiming = onTime ? "On time" : "Off beat";
      current.lastStrum = timestamp;
      blocks.push(samples);
    }
    if (level < 2 * current.floor) current.floor = Math.max(0.0003, 0.98 * current.floor + 0.02 * level);
    current.previous = level;
  }

  function stop() {
    button.textContent = "Start song";
    position.textContent = "";
    highlight(-1, -1);
    setEditing(true);
  }

  return { button, message, read, setEditing, start, capture, stop };
}
