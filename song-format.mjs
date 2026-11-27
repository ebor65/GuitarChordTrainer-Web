import { chords } from "./music.mjs";
import { arrangement, gridOptions, meterGrid, meters, readPattern, validBpm } from "./rhythm.mjs";

const fields = new Set(["title", "artist", "key", "tuning", "capo", "meter", "bpm", "subdivision",
  "timing", "chart url", "default pattern"]);
const chordMarker = /^[A-Z](?:[#♯b♭])?(?:(?:maj|min|dim|aug|sus|add|m|M)?\d*|[+°])(?:\/[A-G][#♯b♭]?)?(?:[:@].*)?$/;
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
    const target = key.startsWith("pattern ") ? patterns : values;
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
  const meter = meterField
    ? Number(Object.keys(meters).find(key => meters[key].name === meterField.value))
    : fallback.meter ?? defaults.meter;
  if (!Object.hasOwn(meters, meter)) {
    throw errorAt(meterField?.line ?? 1, `Unsupported meter. Supported meters are ${Object.values(meters).map(grid => grid.name).join(", ")}.`);
  }
  const subdivisionField = values.get("subdivision");
  const originalKind = (subdivisionField?.value ?? fallback.kind ?? meters[meter].kind).toLowerCase();
  const kind = ["eighth", "eighth-note", "eighth notes"].includes(originalKind) || (meter === 6 && originalKind === "straight")
    ? meters[meter].kind : originalKind;
  const choices = gridOptions(meter);
  if (!choices.some(grid => grid.kind === kind)) {
    throw errorAt(subdivisionField?.line ?? 1,
      `Unsupported subdivision for ${meters[meter].name}. Supported subdivisions are ${choices.map(grid => grid.kind).join(", ")} (eighth is an alias for ${meters[meter].kind}).`);
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
    try { patterns.push({ name, value: readPattern(field.value, meter, kind) }); }
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
  return { start, meter, grid, bpm, meta, patterns, preferred };
}

function durationSlots(text, grid, line) {
  const match = /^(\d+(?:\.\d+)?)(?:\/(\d+))?$/.exec(text.trim());
  const slots = match ? Number(match[1]) * grid.subdivision / (match[2] === undefined ? 1 : Number(match[2])) : NaN;
  const whole = Math.round(slots);
  if (!Number.isSafeInteger(whole) || whole <= 0 || Math.abs(slots - whole) > 1e-8) {
    throw errorAt(line, `Duration must be positive and fit the ${grid.kind} subdivision (${grid.subdivision} slots per beat).`);
  }
  return whole;
}

function positionSlot(text, grid, line) {
  const match = /^([1-9]\d*)\.([1-4])(?:(\&)|\.([1-3]))?$/.exec(text.trim());
  if (!match || Number(match[2]) > beatsPerBar(grid) || (match[3] && grid.subdivision !== 2) ||
      Number(match[4] ?? 1) > grid.subdivision) {
    throw errorAt(line, `Use a bar.beat position for ${grid.name}, such as @1.1${grid.subdivision === 2 ? " or @1.1&" : " or @1.1.2"}.`);
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
  const { start, meter, grid, bpm, meta, patterns, preferred } = readSetup(lines, fallback);
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
      if (!Object.hasOwn(chords, chord)) throw errorAt(line, `Chord ${chord} is unavailable. Supported chords: ${Object.keys(chords).join(", ")}.`);
      const markerType = match[2];
      if (positioned && markerType === ":") throw errorAt(line, "Use beat durations or @ positions throughout the chart.");
      const duration = markerType === ":" ? durationSlots(match[3], grid, line) : size;
      const slot = markerType === "@" ? positionSlot(match[3], grid, line) : cursor;
      if (!Number.isSafeInteger(slot + duration) || slot <= (changes.at(-1)?.slot ?? -1) || (!changes.length && slot !== 0)) {
        throw errorAt(line, "Start at 1.1 and put chord positions in increasing order.");
      }
      section.start ??= slot;
      piece.change = changes.length;
      changes.push({ chord, lyrics: piece.text, slot, explicit: Boolean(markerType), line });
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
  return { ...arrangement(preferred.value, changes, meter, { kind: grid.kind, endSlot: cursor }),
    bpm, meta, patterns, defaultPattern: preferred.name, sections };
}

export function parseSong(source, tempo, strumming, meter = 4) {
  return parseSongText(source, { tempo, pattern: strumming, meter });
}

export const formatGuide = `Use Title, Meter, and BPM headers for a formatted chart. With chords only, those headers are optional.\n${
  Object.entries(meters).map(([meter, grid]) => `${grid.name} ${gridOptions(Number(meter)).map(option =>
    `${option.kind}: ${option.labels.length} slots`).join(" or ")}`).join(" · ")
}\nAdd [Verse 1] or [Bridge] headings and chords such as [G] or [C:2]. An untimed chord lasts a bar. Beat durations use quarter notes, or dotted quarters in 6/8. Use Pattern Name: D/U/- slots and Default Pattern: Name.`;
