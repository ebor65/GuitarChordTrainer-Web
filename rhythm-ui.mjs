import { beats, strokes, presets, readPattern, resizePattern, arrangement, clampBpm, validBpm,
  RhythmTimeline, RhythmClock, RhythmAudio } from "./rhythm.mjs";

export function createRhythmPanel(container, options) {
  container.append(document.getElementById("rhythm-controls").content.cloneNode(true));
  const get = (name) => container.querySelector(`[data-rhythm="${name}"]`);
  const meter = get("meter");
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
  const locked = [meter, pattern, countIn, sound, ...options.locked];
  const buttons = [];
  let session;
  let previousPulse;
  let previousBar;
  let taps = [];

  meter.value = options.meter;
  pattern.value = options.pattern;
  bpm.value = options.bpm;
  demo.textContent = options.demoLabel;
  practice.textContent = options.practiceLabel;

  function settings() {
    const beatsPerBar = Number(meter.value);
    return { meter: beatsPerBar, pattern: readPattern(pattern.value, beatsPerBar) };
  }

  function updateGrid() {
    const size = Number(meter.value) * 2;
    const value = resizePattern(pattern.value, Number(meter.value));
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
          const next = [...resizePattern(pattern.value, Number(meter.value))];
          const order = "DU-";
          next[index] = order[(order.indexOf(next[index]) + 1) % order.length];
          pattern.value = next.join(" ");
          options.custom?.();
          preview(true);
        });
        buttons.push(button);
        grid.append(button);
      }
    }
    grid.style.setProperty("--slots", size);
    buttons.forEach((button, index) => {
      const stroke = value[index];
      button.firstChild.textContent = beats[index];
      button.lastChild.textContent = strokes[stroke];
      const beat = index % 2 ? `and after beat ${Math.floor(index / 2) + 1}` : `Beat ${beats[index]}`;
      button.setAttribute("aria-label", `${beat}, ${{ D: "downstroke", U: "upstroke", "-": "rest" }[stroke]}. Change stroke`);
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
    const label = !pulse ? "" : pulse.countIn ? "Count-in" :
      `Bar ${Math.floor(pulse.slot / size) + 1} of ${session.timeline.song.slots / size}`;
    if (label !== previousBar) {
      position.textContent = label;
      previousBar = label;
    }
    const chord = pulse?.chord ?? "—";
    const next = pulse?.nextChord ?? "—";
    if (currentChord.textContent !== chord) currentChord.textContent = chord;
    if (nextChord.textContent !== next) nextChord.textContent = next;
    options.onPulse?.(pulse);
  }

  function playing(on) {
    for (const field of locked) field.disabled = on;
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
    pattern.value = resizePattern(pattern.value, Number(meter.value)).split("").join(" ");
    options.custom?.();
    preview(true);
  });
  pattern.addEventListener("change", () => { options.custom?.(); preview(true); });
  pattern.addEventListener("input", updateGrid);
  preview(false);
  return {
    stop, preview, setBpm,
    setPattern(nextMeter, nextPattern) {
      meter.value = nextMeter;
      pattern.value = [...nextPattern].join(" ");
      preview(false);
    },
  };
}

export function createStrumming(container, beforeStart) {
  const preset = container.querySelector("#strum-preset");
  const muted = container.querySelector("#strum-muted");
  const repeat = container.querySelector("#strum-repeat");
  for (const name of [...Object.keys(presets), "Custom"]) preset.add(new Option(name, name));
  const [meter, pattern, bpm] = presets[preset.value];
  const controls = createRhythmPanel(container.querySelector("#strum-rhythm"), {
    meter, pattern, bpm, beforeStart,
    demoLabel: "Hear Pattern", practiceLabel: "Start Practice",
    locked: [preset, muted, repeat],
    custom() { preset.value = "Custom"; },
    read({ pattern }) {
      const song = arrangement(pattern, [{ slot: 0, chord: muted.checked ? "Muted strings" : "G" }]);
      return { song, from: 0, to: song.slots, loop: repeat.checked };
    },
  });
  preset.addEventListener("change", () => {
    if (preset.value === "Custom") return;
    const [meter, pattern, bpm] = presets[preset.value];
    controls.setPattern(meter, pattern);
    controls.setBpm(bpm);
  });
  return controls;
}
