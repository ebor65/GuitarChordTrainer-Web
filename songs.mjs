import { chords } from "./music.mjs";
import { arrangement, readPattern, slotLabel, validBpm } from "./rhythm.mjs";
import { createRhythmPanel } from "./rhythm-ui.mjs";

const defaultSong = `[G]Morning rolls across the hill
[C]Windows catch the light
[Em]I can hear the city waking
[D]After all the night
[G]Take the road beside the river
[C]Leave the rush behind
[Em]Let the open strings keep ringing
[D]One more bar in time
[G]Bring it home`;
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

export function parseSong(source, tempo, strumming, meter = 4) {
  if (!validBpm(tempo)) throw new Error("Choose a saved song tempo between 40 and 150 BPM.");
  if (![3, 4].includes(meter)) throw new Error("Choose 3/4 or 4/4.");
  const pattern = readPattern(strumming, meter);
  const bars = /[\[\]]/.test(source) ? readInlineBars(source) : readAlignedBars(source);
  if (!bars.length) throw new Error("Enter a chord and lyric sheet.");
  let previous = -pattern.length;
  const changes = bars.map(({ chord: marker, lyrics }) => {
    const [chord, position, extra] = marker.split("@").map((part) => part.trim());
    if (!Object.hasOwn(chords, chord)) {
      throw new Error(`Chord ${chord} is unavailable. Supported chords: ${Object.keys(chords).join(", ")}.`);
    }
    let slot = (Math.floor(previous / pattern.length) + 1) * pattern.length;
    if (position !== undefined) {
      const match = /^([1-9]\d*)\.([1-4])(&?)$/.exec(position);
      if (!match || extra !== undefined || Number(match[2]) > meter) {
        throw new Error(`Use bar.beat positions such as [${chord}@2.1] or [${chord}@2.1&] in ${meter}/4.`);
      }
      slot = (Number(match[1]) - 1) * pattern.length + (Number(match[2]) - 1) * 2 + Number(Boolean(match[3]));
    }
    if (!Number.isSafeInteger(slot + pattern.length) || slot <= previous || (previous < 0 && slot !== 0)) {
      throw new Error("Start at 1.1 and put chord positions in increasing order.");
    }
    previous = slot;
    return { chord, lyrics, slot, explicit: position !== undefined };
  });
  return arrangement(pattern, changes);
}


function loadSavedSong() {
  const fallback = { source: defaultSong, tempo: 84, pattern: "D-DU-UDU", meter: 4 };
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (saved) {
      saved.meter ??= 4;
      parseSong(saved.source, saved.tempo, saved.pattern, saved.meter);
      return saved;
    }
  } catch {
    // Invalid or unavailable storage leaves the example available.
  }
  return fallback;
}

export function createSongPractice(container, beforeStart) {
  const get = (id) => container.querySelector(`#song-${id}`);
  const source = get("source");
  const tempo = get("tempo");
  const sheet = get("sheet");
  const firstBar = get("first");
  const lastBar = get("last");
  const saved = loadSavedSong();
  source.value = saved.source;
  tempo.value = saved.tempo;
  let rows = [];
  let activeRow;
  let renderedSong;
  const controls = createRhythmPanel(get("rhythm"), {
    meter: saved.meter, pattern: saved.pattern, bpm: saved.tempo,
    demoLabel: "Listen", practiceLabel: "Play Along",
    locked: [source, tempo, get("explicit"), get("loop"), firstBar, lastBar],
    beforeStart,
    read({ meter, pattern }, preview) {
      const song = parseSong(source.value, tempo.valueAsNumber, pattern, meter);
      const bars = song.slots / song.pattern.length;
      if (preview) return { song, from: 0, to: song.slots, loop: false };
      const first = firstBar.valueAsNumber;
      const last = lastBar.valueAsNumber;
      if (get("loop").checked && (!Number.isInteger(first) || !Number.isInteger(last) ||
          first < 1 || first > last || last > bars)) {
        throw new Error(`Choose a loop from bar 1 through ${bars}. Use the same bar twice to repeat it.`);
      }
      return get("loop").checked ?
        { song, from: (first - 1) * pattern.length, to: last * pattern.length, loop: true } :
        { song, from: 0, to: song.slots, loop: false };
    },
    render(song) {
      if (renderedSong && renderedSong.pattern === song.pattern &&
          JSON.stringify(renderedSong.changes) === JSON.stringify(song.changes)) return;
      renderedSong = song;
      const bars = song.slots / song.pattern.length;
      if (lastBar.value === "" || lastBar.valueAsNumber > bars) lastBar.value = bars;
      if (firstBar.valueAsNumber > bars) firstBar.value = bars;
      firstBar.max = lastBar.max = bars;
      activeRow = undefined;
      rows = song.changes.map(({ chord, lyrics, slot, explicit }) => {
        const row = document.createElement("li");
        const name = document.createElement("strong");
        const time = document.createElement("small");
        const line = document.createElement("span");
        name.textContent = chord;
        time.textContent = slotLabel(slot, song.pattern.length) + (explicit ? "" : " (default)");
        line.textContent = lyrics;
        row.append(name, time, line);
        return row;
      });
      sheet.replaceChildren(...rows);
    },
    onPulse(pulse) {
      const row = pulse && !pulse.countIn ? rows[pulse.row] : undefined;
      if (row === activeRow) return;
      activeRow?.classList.remove("active");
      activeRow?.removeAttribute("aria-current");
      activeRow = row;
      if (row) {
        row.classList.add("active");
        row.setAttribute("aria-current", "true");
        sheet.scrollTop += row.getBoundingClientRect().top - sheet.getBoundingClientRect().top -
          (sheet.clientHeight - row.offsetHeight) / 2;
      }
    },
    save({ meter, pattern }) {
      localStorage.setItem(storageKey, JSON.stringify({
        source: source.value, tempo: tempo.valueAsNumber, meter, pattern,
      }));
    },
  });
  source.addEventListener("change", () => controls.preview(true));
  tempo.addEventListener("change", () => controls.preview(true));
  get("song-speed").addEventListener("click", () => {
    if (validBpm(tempo.valueAsNumber)) controls.setBpm(tempo.valueAsNumber);
  });
  get("explicit").addEventListener("click", () => {
    const song = controls.preview(false);
    if (!song) return;
    source.value = song.changes.map(({ chord, slot, lyrics }) =>
      `[${chord}@${slotLabel(slot, song.pattern.length)}]${lyrics}`).join("\n");
    controls.preview(true);
  });
  return controls;
}
