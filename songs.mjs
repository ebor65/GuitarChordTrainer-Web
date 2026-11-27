import { gridOptions, meterKey, slotLabel, strokeAt } from "./rhythm.mjs";
import { createRhythmPanel } from "./rhythm-ui.mjs";
import { formatGuide, parseSongText, updateTimingHeaders } from "./song-format.mjs";

export { parseSong } from "./song-format.mjs";

const morning = {
  id: "builtin-morning",
  source: `Title: Morning Walk
Meter: 4/4
BPM: 84
Pattern Folk: D - D U - U D U

[G]Morning rolls across the hill
[C]Windows catch the light
[Em]I can hear the city waking
[D]After all the night
[G]Take the road beside the river
[C]Leave the rush behind
[Em]Let the open strings keep ringing
[D]One more bar in time
[G]Bring it home`,
};
const dreamId = "builtin-dream";
const tripletId = "builtin-dream-triplet";
const libraryKey = "guitar-chord-trainer-song-library-v2";
const legacyKey = "guitar-chord-trainer-song-v1";

export function loadLibrary() {
  try {
    const saved = JSON.parse(localStorage.getItem(libraryKey));
    if (saved && Array.isArray(saved.songs)) {
      const ids = new Set();
      const songs = saved.songs.filter(entry => {
        if (typeof entry?.id !== "string" || entry.id.startsWith("builtin-") || ids.has(entry.id)) return false;
        try { parseSongText(entry.source, entry.fallback); } catch { return false; }
        ids.add(entry.id);
        return true;
      });
      return { songs, selected: saved.selected };
    }
    const legacy = JSON.parse(localStorage.getItem(legacyKey));
    if (legacy) {
      const { source, ...fallback } = legacy;
      fallback.title = "Previously saved song";
      parseSongText(source, fallback);
      return { songs: [{ id: "saved-legacy", source, fallback }], selected: "saved-legacy" };
    }
  } catch {
    // If storage is unavailable, the built-in songs remain playable.
  }
  return { songs: [], selected: morning.id };
}

export function saveLibrary(library) {
  localStorage.setItem(libraryKey, JSON.stringify(library));
}

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function beatCount(slots, subdivision) {
  return Number((slots / subdivision).toFixed(3));
}

function scheduledPattern(song, row, start, end) {
  return Array.from({ length: end - start }, (_, index) => strokeAt(song, start + index, row)).join(" ");
}

function renderChart(song, target, preview = false) {
  const metadata = song.meta;
  const heading = node("div", "", "song-summary");
  heading.append(node("h3", metadata.title));
  if (metadata.artist) heading.append(node("p", metadata.artist));
  const details = [
    `${song.grid.name} ${song.kind} · ${song.bpm} BPM`,
    ...[["key", "Key"], ["tuning", "Tuning"], ["capo", "Capo"]].flatMap(([key, label]) =>
      metadata[key] ? [`${label} ${metadata[key]}`] : []),
  ];
  heading.append(node("p", details.join(" · "), "message"));
  if (metadata.timing) heading.append(node("p", metadata.timing, "message"));
  if (metadata["chart url"]) {
    const link = node("a", "Open reference chart");
    link.href = metadata["chart url"];
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    heading.append(link);
  }
  if (preview) {
    const patterns = node("ul", "", "song-pattern-preview");
    for (const { name, value } of song.patterns) {
      patterns.append(node("li", `${name}${name === song.defaultPattern ? " (default)" : ""} · ${value}`));
    }
    heading.append(patterns);
    const timing = node("details");
    timing.append(node("summary", "Chord timing and patterns"));
    const events = node("ol");
    for (const [row, event] of song.changes.entries()) {
      const position = slotLabel(event.slot, song.barSlots, song.grid.subdivision);
      const duration = beatCount(event.duration, song.grid.subdivision);
      const end = Math.min(event.slot + event.duration, event.slot + song.barSlots);
      const pattern = scheduledPattern(song, row, event.slot, end);
      events.append(node("li", event.chord + " · " + position + " · " + duration + " beats · " +
        (event.localPattern ? "Local " + event.localPattern + " · " : "") + pattern +
        (end < event.slot + event.duration ? " …" : "")));
    }
    timing.append(events);
    heading.append(timing);
    heading.append(node("p", "Default chord: " + beatCount(song.defaultSlots, song.grid.subdivision) +
      " beats · " + song.patternMode, "message"));
  }

  const chords = [];
  const phrases = [];
  const items = song.sections.map(section => {
    const block = node("section", "", "song-section");
    if (section.title) block.append(node("h4", section.title));
    for (const pieces of section.phrases) {
      const phrase = node("div", "", "song-phrase");
      for (const { text, change } of pieces) {
        if (change === undefined) {
          phrase.append(node("span", text, "song-unmarked"));
          continue;
        }
        const fragment = node("span", "", "song-fragment");
        const chord = node("strong", song.changes[change].chord);
        fragment.append(chord, node("span", text || " "));
        phrase.append(fragment);
        chords[change] = chord;
        phrases[change] = phrase;
      }
      block.append(phrase);
    }
    return block;
  });
  target.replaceChildren(heading, ...items);
  return { chords, phrases };
}

export function createSongPractice(container, beforeStart) {
  const get = id => container.querySelector(`#song-${id}`);
  const picker = get("picker");
  const editor = get("editor");
  const editButton = get("edit");
  const player = get("player");
  const source = get("source");
  const sheet = get("sheet");
  const patternPicker = get("pattern");
  const range = get("section");
  const firstBar = get("first");
  const seekBar = get("seek");
  const eventText = get("event");
  const timing = get("timing-fields");
  const timingButton = get("timing");
  const timingInputs = ["meter", "bpm", "division", "beats", "pattern", "mode"].map(name => get("timing-" + name));
  const [timingMeter, timingBpm, timingDivision, timingBeats, timingPattern, timingMode] = timingInputs;
  let timingDraft;
  const lastBar = get("last");
  const builtins = [morning];
  let library = loadLibrary();
  let song = parseSongText(morning.source);
  let selected = morning.id;
  let editing;
  let countSelections = 0;
  let rows = { chords: [], phrases: [] };
  let activeRow = -1;
  get("format").textContent = formatGuide;

  const controls = createRhythmPanel(get("rhythm"), {
    meter: song.meter, kind: song.kind, pattern: song.pattern, bpm: song.bpm, fixedMeter: true,
    demoLabel: "Listen", practiceLabel: "Play Along", beforeStart,
    locked: [range, get("repeat"), firstBar, lastBar, patternPicker],
    custom() {
      if (!patternPicker.querySelector('[value=""]')) patternPicker.add(new Option("Custom", ""));
      patternPicker.value = "";
    },
    onReady(ready) { get("seek-go").disabled = !ready; },
    read({ pattern }, preview) {
      const arranged = { ...song, pattern };
      const repeat = get("repeat").checked;
      if (preview || range.value === "all") return { song: arranged, from: 0, to: arranged.slots, loop: !preview && repeat };
      if (range.value !== "bars") {
        const section = song.sections[Number(range.value)];
        return { song: arranged, from: section.start, to: section.end, loop: repeat };
      }
      const size = song.barSlots;
      const bars = Math.ceil(song.slots / size);
      const first = firstBar.valueAsNumber;
      const last = lastBar.valueAsNumber;
      if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || first > last || last > bars) {
        throw new Error(`Choose a range from bar 1 through ${bars}.`);
      }
      return { song: arranged, from: (first - 1) * size, to: Math.min(last * size, song.slots), loop: repeat };
    },
    onPulse(pulse, played) {
      const row = pulse && !pulse.countIn ? pulse.row : -1;
      eventText.hidden = row < 0;
      if (row >= 0) {
        const { barSlots, grid: { subdivision } } = played;
        const event = played.changes[row];
        const from = Math.max(event.slot, pulse.slot - pulse.beat);
        const to = Math.min(event.slot + event.duration, pulse.slot - pulse.beat + barSlots);
        const timing = slotLabel(pulse.slot, barSlots, subdivision);
        const text = event.chord + " · Bar/beat " + timing + " · " + beatCount(pulse.duration, subdivision) +
          " beats, " + beatCount(pulse.remaining, subdivision) + " remaining · " +
          (from > event.slot ? "… " : "") + scheduledPattern(played, row, from, to) +
          (to < event.slot + event.duration ? " …" : "");
        if (eventText.textContent !== text) eventText.textContent = text;
      }
      if (row === activeRow) return;
      rows.chords[activeRow]?.classList.remove("active");
      rows.chords[activeRow]?.removeAttribute("aria-current");
      rows.phrases[activeRow]?.classList.remove("active");
      activeRow = row;
      const phrase = rows.phrases[row];
      if (phrase) {
        rows.chords[row].classList.add("active");
        rows.chords[row].setAttribute("aria-current", "true");
        phrase.classList.add("active");
        const bounds = phrase.getBoundingClientRect();
        const viewport = sheet.getBoundingClientRect();
        if (bounds.top < viewport.top || bounds.bottom > viewport.bottom) {
          sheet.scrollTop += bounds.top - viewport.top - (sheet.clientHeight - phrase.offsetHeight) / 2;
        }
      }
    },
  });

  function displaySelected(id, saveSelection = false) {
    const available = [...builtins, ...library.songs];
    const entry = available.find(item => item.id === id) ?? available[0];
    controls.stop();
    selected = entry.id;
    song = parseSongText(entry.source, entry.fallback);
    rows = renderChart(song, sheet);
    sheet.scrollTop = 0;
    activeRow = -1;
    patternPicker.replaceChildren(...song.patterns.map(({ name }) => new Option(name, name)));
    patternPicker.value = song.defaultPattern;
    range.replaceChildren(new Option("Full song", "all"));
    const seen = new Map();
    song.sections.forEach((item, index) => {
      if (!item.title) return;
      const number = (seen.get(item.title) ?? 0) + 1;
      seen.set(item.title, number);
      range.add(new Option(number === 1 ? item.title : `${item.title} (${number})`, index));
    });
    range.add(new Option("Bar range", "bars"));
    get("bars").hidden = true;
    const bars = Math.ceil(song.slots / song.barSlots);
    firstBar.value = seekBar.value = 1;
    seekBar.max = bars;
    firstBar.max = lastBar.max = bars;
    lastBar.value = bars;
    get("repeat").checked = false;
    controls.setPattern(song.meter, song.pattern, song.kind);
    controls.setBpm(song.bpm);
    picker.value = entry.id;
    updateSongAction();
    get("status").textContent = "";
    if (saveSelection) {
      const next = { ...library, selected: entry.id };
      try {
        saveLibrary(next);
        library = next;
      } catch {
        get("status").textContent = "The selection could not be saved on this device.";
      }
    }
  }

  function showPicker() {
    const groups = [["Built-in songs", builtins], ["Saved songs", library.songs]];
    picker.replaceChildren(...groups.map(([label, entries]) => {
      const group = node("optgroup");
      group.label = label;
      const seen = new Map();
      for (const entry of entries) {
        const { meta } = parseSongText(entry.source, entry.fallback);
        const label = meta.artist ? `${meta.title} · ${meta.artist}` : meta.title;
        const count = (seen.get(label) ?? 0) + 1;
        seen.set(label, count);
        group.append(new Option(count > 1 ? `${label} (${count})` : label, entry.id));
      }
      return group;
    }));
    picker.value = selected;
  }

  function selectedSavedSong() {
    return library.songs.find(entry => entry.id === picker.value);
  }

  function updateSongAction() {
    editButton.textContent = selectedSavedSong() ? "Edit song" : "Customize copy";
    editButton.disabled = Boolean(editing) || !picker.value;
  }

  function openEditor(entry, copy = false) {
    ++countSelections;
    controls.stop();
    closeTiming();
    editing = { entry: copy ? undefined : entry, original: entry?.source ?? "" };
    source.value = editing.original;
    player.hidden = true;
    editor.hidden = false;
    picker.disabled = get("add").disabled = true;
    updateSongAction();
    get("editor-heading").textContent = copy ? "Customize copy" : entry ? "Edit song" : "Add song";
    get("editor-error").textContent = "";
    get("preview-sheet").replaceChildren();
    get("preview-sheet").hidden = true;
    source.focus();
  }

  function closeEditor(focus = true) {
    closeTiming();
    editing = undefined;
    editor.hidden = true;
    player.hidden = false;
    picker.disabled = get("add").disabled = false;
    updateSongAction();
    if (focus) picker.focus();
  }

  function readEditor() {
    const status = get("editor-error");
    try {
      const draft = parseSongText(source.value, editing.entry?.fallback);
      status.textContent = "";
      return draft;
    } catch (error) {
      status.textContent = error.message;
      get("preview-sheet").hidden = true;
      return null;
    }
  }

  function closeTiming() {
    timingDraft = undefined;
    timing.hidden = true;
    timingButton.setAttribute("aria-expanded", "false");
  }

  function chooseSubdivisions(preferred) {
    const meter = meterKey(timingMeter.value.trim());
    if (meter === null) return;
    timingDivision.replaceChildren(...gridOptions(meter).map(option => new Option(option.kind)));
    if ([...timingDivision.options].some(option => option.value === preferred)) timingDivision.value = preferred;
  }

  timingButton.addEventListener("click", () => {
    if (!timing.hidden) {
      closeTiming();
      return;
    }
    timingDraft = readEditor();
    if (!timingDraft) return;
    timingMeter.value = timingDraft.grid.name;
    timingBpm.value = timingDraft.bpm;
    chooseSubdivisions(timingDraft.kind);
    timingBeats.value = timingDraft.meta["default chord beats"] ?? "";
    timingPattern.replaceChildren(...timingDraft.patterns.map(({ name }) => new Option(name)));
    timingPattern.value = timingDraft.defaultPattern;
    timingMode.value = timingDraft.patternMode;
    timing.hidden = false;
    timingButton.setAttribute("aria-expanded", "true");
    timingMeter.focus();
  });
  timingMeter.addEventListener("change", () => chooseSubdivisions(timingDivision.value));
  source.addEventListener("input", closeTiming);
  get("timing-apply").addEventListener("click", () => {
    if (!timingDraft) return;
    const values = timingInputs.map(input => input.value);
    if (!values[0].trim() || !values[1].trim()) {
      get("editor-error").textContent = "Enter a meter and saved BPM.";
      return;
    }
    const next = updateTimingHeaders(source.value, timingDraft, values);
    try {
      parseSongText(next, editing.entry?.fallback);
    } catch (error) {
      get("editor-error").textContent = error.message;
      return;
    }
    source.value = next;
    get("preview-sheet").hidden = true;
    get("editor-error").textContent = "";
    closeTiming();
    source.focus();
  });

  get("add").addEventListener("click", () => openEditor());
  editButton.addEventListener("click", () => {
    const saved = selectedSavedSong();
    if (saved) openEditor(saved);
    else {
      const builtIn = builtins.find(entry => entry.id === picker.value);
      if (builtIn) openEditor(builtIn, true);
    }
  });
  get("cancel").addEventListener("click", () => closeEditor());
  get("preview").addEventListener("click", () => {
    const draft = readEditor();
    if (draft) {
      renderChart(draft, get("preview-sheet"), true);
      get("preview-sheet").hidden = false;
    }
  });
  get("save").addEventListener("click", () => {
    if (!readEditor()) return;
    const previous = editing.entry;
    const id = previous?.id ?? (`saved-${globalThis.crypto?.randomUUID?.() ?? Date.now() + "-" + Math.random()}`);
    const entry = { id, source: source.value, fallback: previous?.fallback };
    const songs = previous ? library.songs.map(item => item.id === id ? entry : item) : [...library.songs, entry];
    const next = { songs, selected: id };
    try {
      saveLibrary(next);
    } catch {
      get("editor-error").textContent = "Could not save the song. Your previous songs are still available.";
      return;
    }
    library = next;
    closeEditor(false);
    showPicker();
    displaySelected(id);
    get("status").textContent = "Song saved.";
    picker.focus();
  });
  picker.addEventListener("change", () => {
    ++countSelections;
    displaySelected(picker.value, true);
  });
  range.addEventListener("change", () => { get("bars").hidden = range.value !== "bars"; });
  patternPicker.addEventListener("change", () => {
    const pattern = song.patterns.find(({ name }) => name === patternPicker.value);
    if (pattern) controls.setPattern(song.meter, pattern.value, song.kind);
  });
  get("seek-go").addEventListener("click", () => controls.seek((seekBar.valueAsNumber - 1) * song.barSlots));
  seekBar.addEventListener("keydown", event => {
    if (event.key === "Enter") get("seek-go").click();
  });
  get("song-speed").addEventListener("click", () => controls.setBpm(song.bpm));

  const initial = library.selected;
  showPicker();
  displaySelected(initial);
  fetch(new URL("./assets/songs/dream-a-little-dream.txt", import.meta.url)).then(response => {
    if (!response.ok) throw new Error("Could not load the built-in song.");
    return response.text();
  }).then(text => {
    parseSongText(text);
    builtins.push({ id: dreamId, source: text });
    showPicker();
    if (initial === dreamId && countSelections === 0) displaySelected(dreamId);
    const example = get("example");
    example.disabled = false;
    example.addEventListener("click", () => {
      if (source.value.trim() && source.value !== editing.original && source.value !== text &&
          !window.confirm("Replace the unsaved text with the example?")) return;
      source.value = text;
      closeTiming();
      get("preview-sheet").hidden = true;
      get("editor-error").textContent = "";
      source.focus();
    });
  }).catch(error => {
    console.warn(error);
    get("example").title = "The built-in example could not be loaded.";
  });

  fetch(new URL("./assets/songs/dream-a-little-dream-triplet.txt", import.meta.url)).then(response => {
    if (!response.ok) throw new Error("Could not load the triplet arrangement.");
    return response.text();
  }).then(text => {
    parseSongText(text);
    builtins.push({ id: tripletId, source: text });
    showPicker();
    if (initial === tripletId && countSelections === 0) displaySelected(tripletId);
  }).catch(console.warn);

  return controls;
}
