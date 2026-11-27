import { chords } from "./music.mjs";
import { arrangement, gridOptions, meterGrid, meterKey, readPattern, supportedMeters, validBpm } from "./rhythm.mjs";

const fields = new Set(["title", "artist", "key", "tuning", "capo", "meter", "bpm", "subdivision",
  "timing", "chart url", "default pattern", "default chord beats", "pattern mode"]);
const chordMarker = /^[A-Z](?:[#♯b♭])?(?:(?:maj|min|dim|aug|sus|add|m|M)?\d*|[+°])(?:\/[A-G][#♯b♭]?)?(?:[:@].*)?$/;
const patternModes = ["Continuous Across Chords", "Restart On Chord"];
const defaults = { tempo: 84, meter: 4, pattern: "D-DU-UDU" };
const errorAt = (line, message) => new Error(`Line ${line}: ${message}`);
const beatsPerBar = (grid) => grid.labels.length / grid.subdivision;
const normalizeChord = (chord) => chord.replaceAll("♭", "b").replaceAll("♯", "#");

function readHeaders(lines) {
  const values = new Map();
  const patterns = new Map();
  let start = 0;
  for (; start < lines.length; start++) {
    const line = lines[start].trim();
    if (!line) continue;
    const match = /^([A-Za-z][^:|\[\]]*):\s*(.*)$/.exec(line);
    if (!match) break;
    const name = match[1].trim();
    const key = name.toLowerCase();
    // Existing charts could name a D/U/- pattern "Mode".
    const legacyMode = key === "pattern mode" && /^[DU-]+$/i.test(match[2].replace(/\s/g, ""));
    const target = (key.startsWith("pattern ") && !fields.has(key)) || legacyMode ? patterns : values;
    if (target === values && !fields.has(key)) break;
    const id = target === patterns ? name.slice(8).trim() : key;
    if (target.has(id)) throw errorAt(start + 1, `Duplicate ${name}.`);
    if (!match[2].trim()) throw errorAt(start + 1, `Enter a value for ${name}.`);
    target.set(id, { value: match[2].trim(), line: start + 1 });
  }
  return { values, patterns, start };
}

function readSetup(lines, fallback) {
  const { values, patterns: named, start } = readHeaders(lines);
  const structured = values.size || named.size;
  const meterField = values.get("meter");
  const meter = meterKey(meterField?.value ?? fallback.meter ?? defaults.meter);
  if (meter === null) {
    throw errorAt(meterField?.line ?? 1, 'Unsupported meter. Use ' + supportedMeters + '.');
  }
  const subdivisionField = values.get("subdivision");
  const base = meterGrid(meter).kind;
  const originalKind = (subdivisionField?.value ?? fallback.kind ?? base).toLowerCase();
  const kind = ["eighth", "eighth-note", "eighth notes", "straight"].includes(originalKind) && base === "compound"
    ? base : ({ "eighth": "straight", "eighth-note": "straight", "eighth notes": "straight",
      "triplets": "triplet", "swing eighths": "swing", "sixteenths": "sixteenth" })[originalKind] ?? originalKind;
  const choices = gridOptions(meter);
  if (!choices.some(grid => grid.kind === kind)) {
    throw errorAt(subdivisionField?.line ?? 1,
      'Unsupported subdivision for ' + choices[0].name + '. Supported subdivisions are ' + choices.map(grid => grid.kind).join(", ") + '.');
  }

  if (structured) {
    for (const [key, label] of [["title", "Title"], ["meter", "Meter"], ["bpm", "BPM"]]) {
      if (!values.has(key)) throw errorAt(1, `Add a ${label} header.`);
    }
  }
  const grid = meterGrid(meter, kind);
  const bpmField = values.get("bpm");
  const bpm = bpmField ? (/^\d+$/.test(bpmField.value) ? Number(bpmField.value) : NaN) : fallback.tempo ?? defaults.tempo;
  if (!validBpm(bpm)) throw errorAt(bpmField?.line ?? 1, "Choose a saved song tempo between 40 and 150 BPM.");
  const patterns = [];
  for (const [name, field] of named) {
    try { patterns.push({ name, value: readChartPattern(field.value) }); }
    catch (error) { throw errorAt(field.line, `${name}. ${error.message}`); }
  }
  if (!patterns.length) {
    const basic = ("D" + "-".repeat(grid.subdivision - 1)).repeat(beatsPerBar(grid));
    const value = !structured ? fallback.pattern ?? (meter === 4 && kind === "straight" ? defaults.pattern : basic) : basic;
    try { patterns.push({ name: "Basic", value: readPattern(value, meter, kind) }); }
    catch (error) { throw errorAt(1, error.message); }
  }
  const patternField = values.get("default pattern");
  const preferred = patternField ? patterns.find(({ name }) => name === patternField.value) : patterns[0];
  if (!preferred) throw errorAt(patternField.line, `Unknown default pattern. Choose ${patterns.map(({ name }) => name).join(", ")}.`);

  const meta = Object.fromEntries([...values].map(([key, field]) => [key, field.value]));
  const duration = values.get("default chord beats");
  const defaultSlots = duration ? durationSlots(duration.value, grid, duration.line, "Default Chord Beats") : grid.labels.length;
  const mode = values.get("pattern mode");
  const patternMode = mode ? patternModes.find(value => value.toLowerCase() === mode.value.toLowerCase()) : patternModes[0];
  if (!patternMode) throw errorAt(mode.line, 'Pattern Mode must be ' + patternModes.join(" or ") + '.');
  const urlField = values.get("chart url");
  if (urlField) {
    try {
      const url = new URL(urlField.value);
      if (url.protocol !== "https:" || !/^https:\/\//i.test(urlField.value)) throw new Error();
      meta["chart url"] = url.href;
    } catch {
      throw errorAt(urlField.line, "Chart URL must be an HTTPS URL.");
    }
  }
  meta.title ??= fallback.title ?? "Untitled song";
  return { start, meter, grid, bpm, meta, patterns, preferred, defaultSlots, patternMode };
}

export function readChartPattern(text) {
  const pattern = text.toUpperCase().replace(/\s+/g, "");
  if (!pattern || /[^DUX-]/.test(pattern)) throw new Error("Enter a pattern using D, U, X and -.");
  return pattern;
}

function durationSlots(text, grid, line, label) {
  const match = /^((?:\d+(?:\.\d+)?|\.\d+))(?:\/(\d+))?$/.exec(text.trim());
  const slots = match ? Number(match[1]) * grid.subdivision / (match[2] === undefined ? 1 : Number(match[2])) : NaN;
  const whole = Math.round(slots);
  if (!Number.isSafeInteger(whole) || whole <= 0 || Math.abs(slots - whole) > 1e-8) {
    throw errorAt(line, `${label}: duration must be positive and fit the ${grid.kind} subdivision (${grid.subdivision} slots per beat).`);
  }
  return whole;
}

function positionSlot(text, grid, line) {
  const match = /^([1-9]\d*)\.([1-9]\d*)(?:(\&)|\.([1-9]\d*))?$/.exec(text.trim());
  if (!match || Number(match[2]) > beatsPerBar(grid) || (match[3] && grid.subdivision !== 2) ||
      Number(match[4] ?? 1) > grid.subdivision) {
    throw errorAt(line, `Use a bar.beat position for ${grid.name}, such as @1.1${grid.subdivision === 2 ? " or @1.1&" : grid.subdivision > 2 ? " or @1.1.2" : ""}.`);
  }
  return (Number(match[1]) - 1) * grid.labels.length + (Number(match[2]) - 1) * grid.subdivision +
    (match[3] ? 1 : Number(match[4] ?? 1) - 1);
}

function inlinePieces(text, line) {
  const matches = [...text.matchAll(/\[([^\[\]]+)\]/g)];
  const pieces = matches.map(([written, marker], index) => ({
    marker, text: text.slice(matches[index].index + written.length, matches[index + 1]?.index),
  }));
  const prefix = matches.length ? text.slice(0, matches[0].index) : text;
  if (prefix) pieces.unshift({ text: prefix });
  if (pieces.some(piece => /[\[\]]/.test(piece.text))) throw errorAt(line, "Use matching brackets around each chord.");
  return pieces;
}

function alignedChords(line) {
  const names = [...line.matchAll(/\S+/g)];
  return names.length && names.every(({ 0: name }) => chordMarker.test(name) && !/[:@]/.test(name)) ? names : null;
}

export function parseSongText(source, fallback = {}) {
  const lines = source.split(/\r?\n/);
  const { start, meter, grid, bpm, meta, patterns, preferred, defaultSlots, patternMode } = readSetup(lines, fallback);
  const size = grid.labels.length;
  const positioned = lines.slice(start).some(line => /\[[^\[\]]+@[^\[\]]+\]/.test(line));
  const changes = [];
  const sections = [];
  let section = { title: "", line: start + 1, phrases: [] };
  let cursor = 0;

  function append(pieces, line, barLine = false) {
    const startSlot = cursor;
    for (const piece of pieces) {
      if (piece.marker === undefined) continue;
      const marker = piece.marker.trim();
      const match = /^([^:@]+)(?:([:@])(.+))?$/.exec(marker);
      if (!match) throw errorAt(line, `Invalid chord marker [${marker}].`);
      const chord = normalizeChord(match[1].trim());
      if (!Object.hasOwn(chords, chord)) throw errorAt(line, `Chord ${chord} in [${marker}] is unavailable. Supported chords: ${Object.keys(chords).join(", ")}.`);
      const markerType = match[2];
      if (positioned && markerType === ":") throw errorAt(line, "Use beat durations or @ positions throughout the chart.");
      const [durationText, writtenPattern, ...extra] = markerType === ":" ? match[3].split(":") : [];
      if (extra.length) throw errorAt(line, 'Use [Chord:Beats:Pattern] in [' + marker + '].');
      const duration = markerType === ":" && (durationText.trim() || writtenPattern === undefined)
        ? durationSlots(durationText, grid, line, '[' + marker + ']') : defaultSlots;
      let localPattern;
      if (writtenPattern !== undefined) {
        try { localPattern = readChartPattern(writtenPattern); }
        catch (error) { throw errorAt(line, '[' + marker + ']: ' + error.message); }
        if (localPattern.length > duration) throw errorAt(line,
          '[' + marker + '] has ' + localPattern.length + ' strokes or rests. This chord fits ' + duration + ' slots.');
      }
      const slot = markerType === "@" ? positionSlot(match[3], grid, line) : cursor;
      if (!Number.isSafeInteger(slot + duration) || slot <= (changes.at(-1)?.slot ?? -1) || (!changes.length && slot !== 0)) {
        throw errorAt(line, "Start at 1.1 and put chord positions in increasing order.");
      }
      section.start ??= slot;
      piece.change = changes.length;
      changes.push({ chord, lyrics: piece.text, slot, localPattern, marker, explicit: Boolean(markerType), line, section: sections.length });
      cursor = positioned ? (Math.floor(slot / size) + 1) * size : slot + duration;
    }
    if (barLine && cursor - startSlot !== size) {
      throw errorAt(line, `This bar must add up to ${beatsPerBar(grid)} beats (${size} slots) in ${grid.name}.`);
    }
    section.phrases.push(pieces);
  }

  for (let i = start; i < lines.length; i++) {
    const text = lines[i];
    const trimmed = text.trim();
    const line = i + 1;
    if (!trimmed) continue;
    const heading = /^\[([^\[\]]+)\]$/.exec(trimmed);
    if (heading && !chordMarker.test(heading[1].trim())) {
      if (section.title || section.phrases.length) sections.push(section);
      section = { title: heading[1].trim(), line, phrases: [] };
    } else if (/[\[\]]/.test(text)) {
      append(inlinePieces(text, line), line);
    } else if (trimmed.includes("|") && /^[A-Z].*:/.test(trimmed) ||
        /^\S+:\s*\d+(?:[./]\d+)?$/.test(trimmed)) {
      append(trimmed.split("|").map(marker => ({ marker: marker.trim(), text: "" })), line, true);
    } else {
      const names = alignedChords(text);
      if (!names) {
        if (!changes.length) throw errorAt(line, "Start the chart with a chord, such as [G].");
        append([{ text }], line);
        continue;
      }
      const next = lines[i + 1];
      const lyrics = next && !alignedChords(next) && !/[\[\]|]/.test(next) && !/^\s*\S+:\s*\d/.test(next)
        ? lines[++i] : "";
      append(names.map(([marker], index) => ({
        marker, text: lyrics.slice(index ? names[index].index : 0, names[index + 1]?.index),
      })), line);
    }
  }
  if (section.title || section.phrases.length) sections.push(section);
  if (!changes.length) throw errorAt(start + 1, "Enter a chord and lyric sheet.");
  sections.forEach((item, index) => {
    if (item.start === undefined) throw errorAt(item.line, "Add a chord to this section.");
    item.end = sections[index + 1]?.start ?? cursor;
  });
  changes.forEach((change, index) => {
    change.duration = (changes[index + 1]?.slot ?? cursor) - change.slot;
  });
  return { ...arrangement(preferred.value, changes, meter, {
    kind: grid.kind, endSlot: cursor, restart: patternMode === patternModes[1],
  }), bpm, meta, patterns, defaultPattern: preferred.name, defaultSlots, patternMode, sections };
}

export const timingHeaders = ["Meter", "BPM", "Subdivision", "Default Chord Beats", "Default Pattern", "Pattern Mode"];

export function updateTimingHeaders(source, song, values) {
  const lines = source.split(/\r?\n/);
  const { values: existing, patterns, start } = readHeaders(lines);
  const next = [...lines];
  const newHeaders = [];
  if (!existing.has("title")) newHeaders.push("Title: " + song.meta.title);
  timingHeaders.forEach((label, index) => {
    const value = values[index].trim();
    const previous = existing.get(label.toLowerCase());
    const line = value ? label + ": " + value : null;
    if (previous) next[previous.line - 1] = line;
    else if (line) newHeaders.push(line);
  });
  if (!patterns.size) newHeaders.push("Pattern " + song.defaultPattern + ": " + song.pattern);
  if (newHeaders.length) next.splice(start, 0, ...newHeaders, "");
  return next.filter(line => line !== null).join("\n");
}

export function parseSong(source, tempo, strumming, meter = 4) {
  return parseSongText(source, { tempo, pattern: strumming, meter });
}

export const formatGuide = [
  "For formatted charts, include Title, Meter, and BPM. Chord-only charts can omit the headers.",
  "Meter: " + supportedMeters + ". Subdivision: quarter, straight (eighths), triplet, sixteenth, or swing where it fits the beat.",
  "BPM counts the denominator note in simple meters and dotted quarters in 6/8, 9/8, 12/8 and other compound /8 meters.",
  "Default Chord Beats: 2 sets the duration for [G]. If omitted, each untimed chord lasts one bar.",
  "Pattern Main: D - D U and Default Pattern: Main select the repeating pattern. D = down, U = up, X = muted, - = sustain.",
  "Pattern Mode: Restart On Chord starts the default pattern at every chord. Continuous Across Chords follows the song timeline and is the default.",
  "Use [Verse 1] for sections and [F#m:2], [C:0.5:D], [C:2:D-DU] or [C::D] among lyrics. A local pattern plays once and then sustains.",
].join("\n");
