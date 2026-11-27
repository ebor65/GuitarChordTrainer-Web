import { concatenate, estimatePitch, guitarStrings } from "./music.mjs";

export const referenceSeconds = 0.72;
const quietSeconds = 0.45;
const listenSeconds = 4;
const inTuneCents = 5;
const selectedRangeCents = 240;
const stableReadings = 3;

export function stringReading(pitch, target = null) {
  if (!Number.isFinite(pitch) || pitch <= 0) return null;
  const midi = 69 + 12 * Math.log2(pitch / 440);
  const closest = guitarStrings.reduce((best, [, note], i) =>
    Math.abs(note - midi) < Math.abs(guitarStrings[best][1] - midi) ? i : best, 0);
  const index = target ?? closest;
  const cents = (midi - guitarStrings[index][1]) * 100;
  const inRange = target === null || Math.abs(cents) <= selectedRangeCents;
  return { index, closest, cents, inRange, tuned: inRange && Math.abs(cents) <= inTuneCents };
}

export function referenceSamples(midi, rate) {
  const frequency = 440 * 2 ** ((midi - 69) / 12);
  return Float32Array.from({ length: Math.round(referenceSeconds * rate) }, (_, index) => {
    const seconds = index / rate;
    const angle = 2 * Math.PI * frequency * seconds;
    const envelope = Math.min(1, seconds / 0.012, (referenceSeconds - seconds) / 0.09) * Math.exp(-3.5 * seconds);
    return 0.22 * envelope * (Math.sin(angle) + 0.18 * Math.sin(2 * angle) + 0.07 * Math.sin(3 * angle));
  });
}

export function createTuner({ element, input, start, stop }) {
  const repeat = element("tuner-repeat");
  const listen = element("tuner-button");
  const direction = element("direction");
  const state = element("tuner-state");
  const message = element("tuner-message");
  const feedback = element("tuner-reference-status");
  const needle = element("needle");
  let tone;
  let repeatJob;
  let repeating = false;
  let guidedTarget = null;
  let correct = 0;
  let confirmed = false;

  const cards = guitarStrings.map(([note], index) => {
    const card = document.createElement("button");
    card.type = "button";
    card.addEventListener("click", () => chooseString(index));
    const label = document.createElement("strong");
    const number = document.createElement("span");
    label.textContent = note;
    number.textContent = 6 - index;
    card.className = "string";
    card.append(label, number);
    element("strings").append(card);
    return card;
  });

  function refresh() {
    const current = input();
    const ready = current?.inputReady;
    const connecting = Boolean(current && !ready);
    listen.textContent = connecting ? "Cancel" : ready ? "Stop listening" : "Start tuner";
    state.textContent = connecting ? "Connecting" : tone ? "Playing reference" : ready ? "Listening" : "Microphone off";
    cards.forEach((card, index) => {
      const note = guitarStrings[index][0];
      card.disabled = connecting;
      const guided = index === guidedTarget;
      card.classList.toggle("selected", guided || index === tone?.index);
      if (guided) card.setAttribute("aria-current", "true");
      else card.removeAttribute("aria-current");
      card.setAttribute("aria-label", `${repeat.checked ? "Tune" : "Play"} ${note}, string ${6 - index}`);
    });
  }

  function renderPitch(pitch) {
    const selected = guidedTarget;
    const reading = stringReading(pitch, selected);
    const shown = reading?.index ?? tone?.index ?? selected;
    const note = shown === null ? "" : guitarStrings[shown][0];
    element("pitch").textContent = shown === null ? "—" : `${note} · String ${6 - shown}`;
    needle.hidden = !reading?.inRange || Boolean(tone);
    cards.forEach((card, index) => card.classList.toggle("active", Boolean(reading?.inRange) && index === shown));
    if (tone) {
      direction.textContent = "Listen to the reference, then pluck your string.";
      element("pitch-detail").textContent = "";
    } else if (!reading) {
      direction.textContent = selected === null ? "Pluck one open string at a time." : `Pluck the open ${note} string.`;
      element("pitch-detail").textContent = "";
    } else if (!reading.inRange) {
      const found = guitarStrings[reading.closest][0];
      direction.textContent = `Heard a note near ${found}. Pluck the selected ${note} string.`;
      element("pitch-detail").textContent = `${pitch.toFixed(1)} Hz`;
    } else {
      const { cents, tuned } = reading;
      direction.textContent = tuned ? "In tune" : cents < 0 ? "Flat · Tighten to raise pitch" : "Sharp · Loosen to lower pitch";
      element("pitch-detail").textContent = `${cents >= 0 ? "+" : ""}${cents.toFixed(1)} cents · ${pitch.toFixed(1)} Hz`;
      needle.style.left = `${50 + Math.max(-100, Math.min(100, cents)) / 2}%`;
      needle.classList.toggle("in-tune", tuned);
    }
    return reading;
  }

  function clearCapture(current, requirePluck = false) {
    if (!current) return;
    current.peaks.length = 0;
    current.recent.length = 0;
    current.waitForPluck = requirePluck;
    current.lastPeak = undefined;
    element("level").value = 0;
  }

  function cancelReference() {
    clearTimeout(repeatJob);
    if (!tone) return;
    const playing = tone;
    tone = undefined;
    clearTimeout(playing.finish);
    if (playing.source) {
      playing.source.onended = null;
      playing.source.stop();
    }
    if (playing.own) void playing.context.close().catch(() => {});
    const current = input();
    if (current?.inputReady) {
      current.ignoreUntil = current.context.currentTime + quietSeconds;
      clearCapture(current, true);
    }
  }

  async function playReference(index) {
    cancelReference();
    const current = input();
    const note = guitarStrings[index];
    let playing;
    try {
      const context = current?.inputReady ? current.context : new AudioContext({ latencyHint: "interactive" });
      playing = { context, index, own: context !== current?.context };
      tone = playing;
      confirmed = false;
      correct = 0;
      feedback.textContent = `Playing ${note[0]}…`;
      clearCapture(current);
      renderPitch(null);
      refresh();

      if (context.state !== "running") await context.resume();
      if (tone !== playing) return;
      const samples = referenceSamples(note[1], context.sampleRate);
      const buffer = context.createBuffer(1, samples.length, context.sampleRate);
      buffer.getChannelData(0).set(samples);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const at = context.currentTime + 0.02;
      const settle = (context.baseLatency || 0) + (context.outputLatency || 0) + (playing.own ? 0.05 : quietSeconds);
      if (current?.inputReady) {
        current.ignoreUntil = at + buffer.duration + settle;
        clearCapture(current, true);
      }
      source.onended = () => {
        playing.finish = setTimeout(() => {
          if (tone !== playing) return;
          tone = undefined;
          if (playing.own) void context.close().catch(() => {});
          refresh();
          renderPitch(null);
          const prompt = guidedTarget === null ? "an open string" : note[0];
          feedback.textContent = current?.inputReady ? `Your turn. Pluck ${prompt}.` : "Reference played. Start the tuner to check your guitar.";
          if (repeating && input() === current && current?.inputReady) {
            repeatJob = setTimeout(() => playReference(index), 1000 * listenSeconds);
          }
        }, 1000 * settle);
      };
      source.start(at);
      playing.source = source;
    } catch {
      if (playing && tone !== playing) return;
      cancelReference();
      repeating = false;
      refresh();
      renderPitch(null);
      feedback.textContent = "Could not play the reference. Check the audio output.";
    }
  }

  function acceptBlock(current, timestamp, peak) {
    if (tone || timestamp < (current.ignoreUntil ?? 0)) return false;
    if (!current.waitForPluck) return true;
    const previous = current.lastPeak;
    current.lastPeak = peak;
    if (previous === undefined || peak <= Math.max(0.003, previous * 1.65)) return false;
    current.waitForPluck = false;
    return true;
  }

  function capture(current, samples, timestamp, peak, meterUpdated) {
    if (!acceptBlock(current, timestamp, peak)) return;
    current.recent.push(samples);
    if (current.recent.length > 10) current.recent.shift();
    if (!meterUpdated || current.recent.length !== 10) return;
    const reading = renderPitch(estimatePitch(concatenate(current.recent), current.context.sampleRate));
    if (confirmed && reading?.inRange && !reading.tuned) {
      confirmed = false;
      feedback.textContent = "";
    }
    correct = reading?.tuned ? correct + 1 : 0;
    if (guidedTarget !== null && correct >= stableReadings && !confirmed) {
      confirmed = true;
      clearTimeout(repeatJob);
      repeating = false;
      feedback.textContent = `Tuned OK · ${guitarStrings[guidedTarget][0]}`;
      refresh();
    }
  }

  function chooseString(index) {
    const current = input();
    if (current && !current.inputReady) return;
    repeating = repeat.checked;
    guidedTarget = repeating ? index : null;
    correct = 0;
    confirmed = false;
    message.textContent = "";
    if (repeating && !current) {
      cancelReference();
      void start();
    } else {
      void playReference(index);
    }
  }

  repeat.addEventListener("change", () => {
    if (!repeat.checked && guidedTarget !== null) {
      const current = input();
      if (current && !current.inputReady) {
        stop();
        return;
      }
      cancelReference();
      repeating = false;
      guidedTarget = null;
      correct = 0;
      confirmed = false;
      clearCapture(current, Boolean(current?.ignoreUntil > current?.context?.currentTime));
      feedback.textContent = "";
      renderPitch(null);
    }
    refresh();
  });
  listen.addEventListener("click", () => {
    if (input()) stop();
    else {
      cancelReference();
      void start();
    }
  });

  refresh();

  return {
    capturing(current, timestamp) { return !tone && timestamp >= (current.ignoreUntil ?? 0); },
    capture,
    connecting() { refresh(); },
    connected() {
      correct = 0;
      confirmed = false;
      refresh();
      renderPitch(null);
      if (guidedTarget !== null) void playReference(guidedTarget);
    },
    reset(text = "") {
      cancelReference();
      repeating = false;
      guidedTarget = null;
      correct = 0;
      confirmed = false;
      feedback.textContent = "";
      message.textContent = text;
      element("level").value = 0;
      element("level-label").textContent = "Off";
      refresh();
      renderPitch(null);
    },
  };
}
