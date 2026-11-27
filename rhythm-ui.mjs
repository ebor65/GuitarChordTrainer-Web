import { gridOptions, meterGrid, meterKey, meters, strokeAt, strokes, presets, readPattern, resizePattern, arrangement, clampBpm, validBpm,
  RhythmTimeline, RhythmClock, RhythmAudio } from "./rhythm.mjs";

import { readChartPattern } from "./song-format.mjs";

const strokeNames = { D: "downstroke", U: "upstroke", X: "muted strum", "-": "sustain" };

export function createRhythmPanel(container, options) {
  container.append(document.getElementById("rhythm-controls").content.cloneNode(true));
  const get = (name) => container.querySelector(`[data-rhythm="${name}"]`);
  const meter = get("meter");
  const division = get("subdivision");
  const unit = get("unit");
  const pattern = get("pattern");
  const bpm = get("bpm");
  const click = get("click");
  const volume = get("volume");
  const guitar = get("guitar");
  const sound = get("sound");
  const countIn = get("count");
  const demo = get("demo");
  const practice = get("practice");
  const pause = get("pause");
  const stopButton = get("stop");
  const grid = get("grid");
  const message = get("status");
  const position = get("position");
  const currentChord = get("current");
  const nextChord = get("next");
  const locked = [meter, division, pattern, countIn, sound, ...options.locked];
  const buttons = [];
  let session;
  let kind = options.kind;
  let previousPulse;
  let previousBar;
  let taps = [];

  const offeredMeters = options.strumming || options.fixedMeter ? Object.keys(meters) : [4, 3];
  meter.replaceChildren(...offeredMeters.map(value => new Option(meters[value].name, value)));
  meter.value = options.meter;
  function setMeter(value) {
    if (![...meter.options].some(option => option.value === String(value))) {
      meter.add(new Option(meterGrid(value).name, value));
    }
    meter.value = value;
    division.replaceChildren(...gridOptions(value).map(grid => new Option(grid.kind, grid.kind)));
    kind = meterGrid(value, kind).kind;
    division.value = kind;
  }
  setMeter(options.meter);
  meter.disabled = division.disabled = Boolean(options.fixedMeter);
  pattern.value = options.pattern;
  bpm.value = options.bpm;
  demo.textContent = options.demoLabel;
  practice.textContent = options.practiceLabel;

  function settings() {
    const selected = meterKey(meter.value);
    const value = options.fixedMeter ? readChartPattern(pattern.value) : readPattern(pattern.value, selected, kind);
    return { meter: selected, kind, pattern: value };
  }

  function updateGrid() {
    const selectedMeter = meterKey(meter.value);
    const definition = meterGrid(selectedMeter, kind);
    const { labels, subdivision, unit: bpmUnit } = definition;
    const size = labels.length;
    const raw = pattern.value.toUpperCase().replace(/\s/g, "").replace(/[^DUX-]/g, "-");
    const value = options.fixedMeter ? raw || "-" : resizePattern(pattern.value, selectedMeter, kind);
    const compound = definition.kind === "compound" && size === 6;
    const triplets = definition.kind === "triplet" && size === 12;
    grid.classList.toggle("compound", compound);
    grid.classList.toggle("triplets", triplets);
    unit.textContent = bpmUnit;
    bpm.setAttribute("aria-label", `Practice BPM (${bpmUnit.toLowerCase()})`);
    while (buttons.length !== size) {
      if (buttons.length > size) {
        buttons.pop().remove();
      } else {
        const index = buttons.length;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "song-beat";
        button.append(document.createElement("small"), document.createElement("strong"));
        button.addEventListener("click", () => {
          let next;
          try { next = [...settings().pattern]; }
          catch (error) { message.textContent = error.message; return; }
          const step = index % next.length;
          const order = "DUX-";
          next[step] = order[(order.indexOf(next[step]) + 1) % order.length];
          pattern.value = next.join(" ");
          options.custom?.();
          preview(true);
        });
        buttons.push(button);
        grid.append(button);
      }
    }
    grid.style.setProperty("--slots", Math.min(size, 12));
    grid.classList.toggle("extended-grid", size > 12);
    buttons.forEach((button, index) => {
      const stroke = value[index % value.length];
      button.firstChild.textContent = labels[index];
      button.lastChild.textContent = strokes[stroke];
      const beat = subdivision !== 2 ? `Slot ${index + 1}` :
        index % 2 ? `and after beat ${Math.floor(index / 2) + 1}` : `Beat ${labels[index]}`;
      button.setAttribute("aria-label", `${beat}, ${strokeNames[stroke]}. Change stroke`);
      button.disabled = Boolean(session);
    });
  }

  function preview(save) {
    updateGrid();
    try {
      const config = settings();
      const { song } = options.read(config, true);
      options.render?.(song);
      message.textContent = "";
      if (save) {
        try { options.save?.(config); }
        catch { message.textContent = "Your changes could not be saved on this device."; }
      }
      return song;
    } catch (error) {
      message.textContent = error.message;
      return null;
    }
  }

  function show(pulse) {
    const beat = pulse?.beat ?? -1;
    if (beat !== previousPulse) {
      buttons[previousPulse]?.classList.remove("active");
      buttons[previousPulse]?.removeAttribute("aria-current");
      buttons[beat]?.classList.add("active");
      buttons[beat]?.setAttribute("aria-current", "step");
      previousPulse = beat;
    }
    const size = buttons.length;
    const barStart = pulse && !pulse.countIn ? pulse.slot - pulse.beat : null;
    if (session && barStart !== session.displayedBar) {
      session.displayedBar = barStart;
      const { song, from, to } = session.timeline;
      buttons.forEach((button, index) => {
        const slot = barStart === null ? -1 : barStart + index;
        const stroke = slot >= from && slot < to ? strokeAt(song, slot) : "-";
        button.lastChild.textContent = strokes[stroke];
        button.setAttribute("aria-label", song.grid.labels[index] + ", " + strokeNames[stroke]);
      });
    }
    if (beat >= 0 && size > 12 && buttons[beat].offsetTop !== buttons[0].offsetTop) {
      const button = buttons[beat];
      grid.scrollTop = Math.max(0, button.offsetTop - buttons[0].offsetTop - button.offsetHeight);
    } else if (beat >= 0) {
      grid.scrollTop = 0;
    }
    const label = !pulse ? "" : pulse.countIn ? "Count-in" :
      `Bar ${Math.floor(pulse.slot / size) + 1} of ${Math.ceil(session.timeline.song.slots / size)}`;
    if (label !== previousBar) {
      position.textContent = label;
      previousBar = label;
    }
    const [first, second] = !pulse && options.idleChords ? options.idleChords() : ["—", "—"];
    const chord = pulse?.chord ?? first;
    const next = pulse ? pulse.nextChord ?? "—" : second;
    if (currentChord.textContent !== chord) currentChord.textContent = chord;
    if (nextChord.textContent !== next) nextChord.textContent = next;
    options.onPulse?.(pulse, session?.timeline.song);
  }

  function playing(on) {
    for (const field of locked) field.disabled = on;
    division.disabled = meter.disabled = on || Boolean(options.fixedMeter);
    demo.disabled = practice.disabled = on;
    pause.disabled = stopButton.disabled = !on;
    pause.textContent = "Pause";
    updateGrid();
  }

  function stop(text = "") {
    if (session) {
      const current = session;
      session = undefined;
      clearInterval(current.timer);
      current.load.abort();
      current.audio?.cancel(current.context.currentTime, true);
      current.context?.close().catch(() => {});
    }
    show(null);
    playing(false);
    options.onReady?.(false);
    message.textContent = text;
  }

  function setBpm(value) {
    bpm.value = clampBpm(value);
    if (session?.clock) {
      const { audio, clock, context } = session;
      const now = context.currentTime;
      if (clock.bpm === bpm.valueAsNumber) return;
      audio.cancel(now, false);
      clock.retime(now, bpm.valueAsNumber, clock.paused);
      fill(session);
    }
  }

  function fill(current) {
    const { context, clock, audio } = current;
    const now = context.currentTime;
    const outputTime = context.getOutputTimestamp?.()?.contextTime;
    const audibleTime = outputTime > 0 ? Math.min(outputTime, now) : now;
    const { phase, paused, pulse } = clock.presentation(audibleTime);
    if (!clock.paused) clock.schedule(now, now + 0.12, (pulse) => audio.play(pulse));
    if (!paused && !current.timeline.loop && phase >= current.timeline.to - current.timeline.from &&
        (!audio.guitar.gain.value || audibleTime >= audio.guitarUntil)) {
      stop("Playback complete.");
      return;
    }
    show(pulse);
  }

  function updateMix() {
    session?.audio?.mix({ click: click.checked, volume: volume.valueAsNumber / 100,
      guitar: session.demo || guitar.checked });
  }

  async function start(isDemo) {
    if (session) return;
    let current;
    try {
      const { song, from, to, loop } = options.read(settings(), false);
      if (!validBpm(bpm.valueAsNumber)) throw new Error("Choose a practice tempo between 40 and 150 BPM.");
      options.render?.(song);
      beforeStart();
      const timeline = new RhythmTimeline(song, from, to, loop, countIn.checked);
      current = { demo: isDemo, timeline, load: new AbortController() };
      session = current;
      playing(true);
      const context = new AudioContext({ latencyHint: "interactive" });
      current.context = context;
      pause.disabled = true;
      message.textContent = "Starting audio…";
      await context.resume();
      if (session !== current) return;
      const synthesized = sound.value === "synthesized";
      current.audio = new RhythmAudio(context, synthesized);
      if (!synthesized) message.textContent = "Loading guitar samples…";
      await current.audio.prepare(song, current.load.signal);
      if (session !== current) return;
      current.clock = new RhythmClock(current.timeline, context.currentTime + 0.07, bpm.valueAsNumber);
      updateMix();
      pause.disabled = false;
      options.onReady?.(true);
      message.textContent = "";
      fill(current);
      current.timer = setInterval(() => fill(current), 20);
    } catch (error) {
      if (current && session === current) stop(`Could not start playback. ${error.message}`);
      else if (!current) message.textContent = error.message;
    }
  }

  const beforeStart = options.beforeStart ?? (() => {});
  demo.addEventListener("click", () => start(true));
  practice.addEventListener("click", () => start(false));
  stopButton.addEventListener("click", () => stop());
  pause.addEventListener("click", () => {
    const current = session;
    const { clock, context, audio } = current;
    const now = context.currentTime;
    const paused = !clock.paused;
    audio.cancel(now, true);
    clock.retime(now, clock.bpm, paused);
    pause.textContent = paused ? "Resume" : "Pause";
    if (!paused) void context.resume().catch(() => {
      if (session === current) stop("Audio was interrupted.");
    });
    fill(session);
  });
  for (const input of [click, guitar, volume]) input.addEventListener("input", updateMix);
  for (const delta of [-5, 5]) {
    get(delta < 0 ? "slower" : "faster").addEventListener("click", () =>
      setBpm((bpm.valueAsNumber || 84) + delta));
  }
  bpm.addEventListener("change", () => {
    if (Number.isFinite(bpm.valueAsNumber)) setBpm(bpm.valueAsNumber);
    else bpm.value = session?.clock?.bpm ?? options.bpm;
  });
  get("tap").addEventListener("click", () => {
    const now = performance.now();
    if (now - taps.at(-1) > 1600) taps = [];
    taps.push(now);
    if (taps.length > 5) taps.shift();
    if (taps.length > 1 && now > taps[0]) setBpm(60000 * (taps.length - 1) / (now - taps[0]));
  });
  meter.addEventListener("change", () => {
    const selected = meterKey(meter.value);
    kind = undefined;
    setMeter(selected);
    const preset = options.onMeter?.(selected);
    if (preset) {
      pattern.value = [...preset[1]].join(" ");
      setBpm(preset[2]);
    } else {
      pattern.value = [...resizePattern(pattern.value, selected)].join(" ");
      options.custom?.();
    }
    preview(true);
  });
  division.addEventListener("change", () => {
    kind = division.value;
    pattern.value = [...resizePattern(pattern.value, meterKey(meter.value), kind)].join(" ");
    options.custom?.();
    preview(true);
  });
  pattern.addEventListener("change", () => { options.custom?.(); preview(true); });
  pattern.addEventListener("input", () => {
    if (options.strumming) {
      options.custom();
      preview(false);
    } else updateGrid();
  });
  preview(false);
  show(null);
  return {
    stop, preview, setBpm,
    seek(slot) {
      if (!session?.clock) return;
      const { timeline, clock, context, audio } = session;
      if (!Number.isInteger(slot) || slot < timeline.from || slot >= timeline.to) {
        message.textContent = "Choose a bar that starts inside the current playback range.";
        return;
      }
      const now = context.currentTime;
      audio.cancel(now, true);
      clock.retime(now, clock.bpm, clock.paused, 0.04, slot - timeline.from);
      message.textContent = "";
      fill(session);
    },
    refreshChords() { if (!session) show(null); },
    setPattern(nextMeter, nextPattern, nextKind) {
      kind = nextKind;
      setMeter(nextMeter);
      pattern.value = [...nextPattern].join(" ");
      preview(false);
    },
  };
}

export function createStrumming(container, beforeStart, chordPair) {
  const preset = container.querySelector("#strum-preset");
  const muted = container.querySelector("#strum-muted");
  const repeat = container.querySelector("#strum-repeat");
  for (const name of [...Object.keys(presets), "Custom"]) preset.add(new Option(name, name));
  const [meter, pattern, bpm] = presets[preset.value];
  function showPresets(selectedMeter, selected) {
    const names = Object.keys(presets);
    const matching = names.filter(name => presets[name][0] === selectedMeter);
    const others = names.filter(name => presets[name][0] !== selectedMeter);
    preset.replaceChildren(...[...matching, "Custom", ...others].map(name => new Option(name, name)));
    preset.value = selected;
  }

  const controls = createRhythmPanel(container.querySelector("#strum-rhythm"), {
    meter, pattern, bpm, beforeStart, strumming: true,
    demoLabel: "Hear Pattern", practiceLabel: "Start Practice",
    locked: [preset, muted, repeat],
    custom() { preset.value = "Custom"; },
    onMeter(meter) {
      const name = meter === 2 ? "2/4 Basic" : meter === 6 ? "6/8 Basic" : "Custom";
      showPresets(meter, name);
      return presets[name];
    },
    idleChords() { return muted.checked ? ["Muted strings", "—"] : chordPair(); },
    read({ meter, kind, pattern }) {
      const names = muted.checked ? ["Muted strings"] : chordPair();
      const song = arrangement(pattern, names.map((chord, index) => ({ slot: index * pattern.length, chord })), meter, { kind });
      return { song, from: 0, to: song.slots, loop: repeat.checked };
    },
  });
  showPresets(meter, preset.value);
  preset.addEventListener("change", () => {
    if (preset.value === "Custom") return;
    const [meter, pattern, bpm] = presets[preset.value];
    showPresets(meter, preset.value);
    controls.setPattern(meter, pattern);
    controls.setBpm(bpm);
  });
  muted.addEventListener("change", controls.refreshChords);
  return controls;
}
