import { chords, guitarStrings, recognizeChord, estimatePitch, concatenate } from "./music.mjs";

const duration = 60;
const countdownSeconds = 3;
const storageKey = "guitar-chord-trainer-v1";
const element = (id) => document.getElementById(id);
const selectors = [element("chord-first"), element("chord-second")];
const shapeCards = [element("shape-first"), element("shape-second")];
const drillButton = element("drill-button");
const tunerButton = element("tuner-button");
const historyFilter = element("history-filter");
const chordNames = Object.keys(chords);
const pairName = (pair) => [...pair].sort().join(" ↔ ");
const timeLabel = (seconds) => seconds == null ? "—" : `${seconds.toFixed(2)} s`;
const dateLabel = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
let storageError = false;
let session;

function loadPractice() {
  const defaults = { pair: ["G", "C"], history: [] };
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey)) ?? {};
    const pair = saved.pair?.length === 2 && saved.pair.every((chord) => chordNames.includes(chord))
      ? saved.pair : defaults.pair;
    return { pair, history: Array.isArray(saved.history) ? saved.history : [] };
  } catch {
    storageError = true;
    return defaults;
  }
}

const practice = loadPractice();

function savePractice() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(practice));
    storageError = false;
  } catch {
    storageError = true;
  }
}

function recordsFor(runs) {
  let best = null;
  let fastest = null;
  for (const run of runs) {
    if (!best || run.good > best.good || (run.good === best.good && run.bad < best.bad)) best = run;
    if (run.fastest !== null && (!fastest || run.fastest < fastest.fastest)) fastest = run;
  }
  return { best, fastest };
}

function drawShape(canvas, chord, active) {
  const [, frets, fingers] = chords[chord];
  const ctx = canvas.getContext("2d");
  const ink = active ? "#275b44" : "#34433a";
  const strings = Array.from({ length: 6 }, (_, index) => 36 + index * 33.6);
  const nut = 56;
  const spacing = 39;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineCap = "round";
  ctx.font = "20px system-ui";
  ctx.fillStyle = ink;
  ctx.strokeStyle = "#78877a";
  for (let fret = 0; fret <= 4; fret++) {
    const y = nut + fret * spacing;
    ctx.lineWidth = fret === 0 ? 6 : 2;
    ctx.beginPath();
    ctx.moveTo(strings[0], y);
    ctx.lineTo(strings[5], y);
    ctx.stroke();
  }
  ctx.lineWidth = 2;
  strings.forEach((x, index) => {
    ctx.beginPath();
    ctx.moveTo(x, nut);
    ctx.lineTo(x, nut + 4 * spacing);
    ctx.stroke();
    ctx.fillText("EADGBe"[index], x, 236);
  });
  ctx.strokeStyle = ink;
  if (fingers.indexOf("1") !== fingers.lastIndexOf("1")) {
    ctx.lineWidth = 20;
    ctx.beginPath();
    ctx.moveTo(strings[0], nut + spacing / 2);
    ctx.lineTo(strings[5], nut + spacing / 2);
    ctx.stroke();
  }
  const description = [];
  strings.forEach((x, index) => {
    const fret = frets[index];
    const finger = fingers[index];
    const name = ["low E", "A", "D", "G", "B", "high E"][index];
    ctx.fillStyle = ink;
    if (fret === "x") {
      ctx.fillText("×", x, 32);
      description.push(`${name} muted`);
    } else if (fret === "0") {
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(x, 31, 6, 0, 2 * Math.PI);
      ctx.stroke();
      description.push(`${name} open`);
    } else {
      const y = nut + (Number(fret) - 0.5) * spacing;
      ctx.beginPath();
      ctx.arc(x, y, 13, 0, 2 * Math.PI);
      ctx.fill();
      ctx.fillStyle = "#fffefa";
      ctx.fillText(finger, x, y + 1);
      description.push(`${name}, fret ${fret}, finger ${finger}`);
    }
  });
  canvas.setAttribute("aria-label", `${chord} chord. ${description.join("; ")}`);
}

function showShapes(active = -1) {
  shapeCards.forEach((card, index) => {
    const highlighted = active === index;
    card.classList.toggle("active", highlighted);
    drawShape(card.querySelector("canvas"), practice.pair[index], highlighted);
  });
  element("target").textContent = active < 0 ? "" : `Play ${practice.pair[active]}`;
}

function showPracticeRecords() {
  const selected = pairName(practice.pair);
  const { best, fastest } = recordsFor(practice.history.filter((run) => pairName(run.pair) === selected));
  element("best-good").textContent = `Best run ${best?.good ?? "—"}`;
  element("best-bad").textContent = `Best run ${best?.bad ?? "—"}`;
  element("best-time").textContent = timeLabel(fastest?.fastest);
}

function updateClock(remaining) {
  const whole = Math.ceil(remaining);
  element("clock").textContent = `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
  element("countdown").value = remaining;
}

function processStrum(current, samples, timestamp, level) {
  if (timestamp < current.audioStartsAt) return;
  const { blocks } = current;
  if (blocks.length) {
    blocks.push(samples);
    if (blocks.length === 11) {
      const heard = recognizeChord(concatenate(blocks.slice(1)), current.context.sampleRate);
      blocks.length = 0;
      const expected = current.pair[current.good % 2];
      if (heard === expected) {
        if (current.lastCorrect !== null) {
          const change = current.lastStrum - current.lastCorrect;
          current.fastest = Math.min(current.fastest ?? Infinity, change);
        }
        current.lastCorrect = current.lastStrum;
        current.good++;
        element("good").textContent = current.good;
        element("drill-message").textContent = `Good, ${heard}.`;
        showShapes(current.good % 2);
      } else {
        current.lastCorrect = null;
        current.bad++;
        element("bad").textContent = current.bad;
        element("drill-message").textContent = heard
          ? `Expected ${expected}. Heard ${heard}.` : `Expected ${expected}. The strum was unclear.`;
      }
    }
  } else if (timestamp <= current.audioDeadline && timestamp - current.lastStrum >= 0.28 &&
    level > Math.max(0.0025, 3 * current.floor, 1.65 * current.previous)) {
    blocks.push(samples);
    current.lastStrum = timestamp;
  }
  if (level < 2 * current.floor) current.floor = Math.max(0.0003, 0.98 * current.floor + 0.02 * level);
  current.previous = level;
}

const stringCards = guitarStrings.map(([note], index) => {
  const card = document.createElement("div");
  const label = document.createElement("strong");
  const number = document.createElement("span");
  label.textContent = note;
  number.textContent = 6 - index;
  card.className = "string";
  card.append(label, number);
  element("strings").append(card);
  return card;
});

function showPitch(pitch) {
  const needle = element("needle");
  needle.hidden = pitch === null;
  if (pitch === null) {
    element("pitch").textContent = "—";
    element("direction").textContent = "Pluck one open string at a time.";
    element("pitch-detail").textContent = "";
    stringCards.forEach((card) => card.classList.remove("active"));
    return;
  }
  const midi = 69 + 12 * Math.log2(pitch / 440);
  const closest = guitarStrings.reduce((best, [, note], index) =>
    Math.abs(note - midi) < Math.abs(guitarStrings[best][1] - midi) ? index : best, 0);
  const [note, target] = guitarStrings[closest];
  const cents = (midi - target) * 100;
  const inTune = Math.abs(cents) <= 5;
  const adjustment = cents < 0 ? "Flat · Tighten to raise pitch" : "Sharp · Loosen to lower pitch";
  stringCards.forEach((card, index) => card.classList.toggle("active", index === closest));
  element("pitch").textContent = `${note} · String ${6 - closest}`;
  element("direction").textContent = inTune ? "In tune" : adjustment;
  element("pitch-detail").textContent = `${cents >= 0 ? "+" : ""}${cents.toFixed(1)} cents · ${pitch.toFixed(1)} Hz`;
  needle.style.left = `${50 + Math.max(-100, Math.min(100, cents)) / 2}%`;
  needle.classList.toggle("in-tune", inTune);
}

function processAudio(current, { samples, timestamp }) {
  if (session !== current || !current.active) return;
  let energy = 0;
  let peak = 0;
  for (const sample of samples) {
    energy += sample ** 2;
    peak = Math.max(peak, Math.abs(sample));
  }
  if (current.mode === "drill") {
    processStrum(current, samples, timestamp, Math.sqrt(energy / samples.length));
    return;
  }
  current.recent.push(samples);
  current.peaks.push(peak);
  if (current.recent.length > 10) current.recent.shift();
  if (current.peaks.length > 20) current.peaks.shift();
  if (timestamp < current.nextPitch) return;
  current.nextPitch = timestamp + 0.1;
  const maxPeak = Math.max(...current.peaks);
  const db = 20 * Math.log10(Math.max(maxPeak, 1e-6));
  element("level").value = Math.max(0, 60 + db);
  element("level-label").textContent = maxPeak >= 0.98 ? "Near clipping" : db < -40 ? "Low signal" : "Signal OK";
  if (current.recent.length === 10) {
    showPitch(estimatePitch(concatenate(current.recent), current.context.sampleRate));
  }
}

function stopSession(message) {
  if (!session) return;
  const current = session;
  session = undefined;
  clearInterval(current.timer);
  current.stream?.getTracks().forEach((track) => track.stop());
  if (current.context?.state !== "closed") current.context?.close().catch(() => {});
  if (current.mode === "drill") {
    drillButton.textContent = "Start drill";
    selectors.forEach((selector) => { selector.disabled = false; });
    showShapes();
    element("drill-message").textContent = message;
  } else {
    tunerButton.textContent = "Start tuner";
    element("tuner-state").textContent = "Microphone off";
    element("level").value = 0;
    element("level-label").textContent = "Off";
    showPitch(null);
    element("tuner-message").textContent = message;
  }
}

function finishDrill(current) {
  practice.history.unshift({
    date: new Date().toISOString(), pair: current.pair, good: current.good,
    bad: current.bad, fastest: current.fastest,
  });
  savePractice();
  showPracticeRecords();
  const changes = Math.max(0, current.good - 1);
  const summary = `Time’s up. ${changes} successful ${changes === 1 ? "change" : "changes"}.`;
  stopSession(storageError ? `${summary} History could not be saved on this device.` : summary);
}

function microphoneError(error) {
  if (error.name === "NotAllowedError" || error.name === "SecurityError") {
    return "Microphone access was blocked. Allow it in your browser settings and try again.";
  }
  if (error.name === "NotFoundError") return "No microphone was found on this device.";
  if (error.name === "NotReadableError") return "The microphone could not be opened. Check whether another app is using it.";
  return "Could not start microphone audio. Check browser support and try again.";
}

async function startSession(mode) {
  const isDrill = mode === "drill";
  const message = element(isDrill ? "drill-message" : "tuner-message");
  if (isDrill && practice.pair[0] === practice.pair[1]) {
    message.textContent = "Choose two different chords to begin.";
    return;
  }
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    message.textContent = "Microphone access requires an HTTPS page or localhost.";
    return;
  }
  const current = { mode, active: false };
  session = current;
  const button = isDrill ? drillButton : tunerButton;
  button.textContent = "Cancel";
  message.textContent = "Waiting for microphone access…";
  if (isDrill) selectors.forEach((selector) => { selector.disabled = true; });

  try {
    current.context = new AudioContext({ latencyHint: "interactive" });
    // Resume from the button press, which provides the user gesture required on phones.
    const resume = current.context.resume().catch((error) => error);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    if (session !== current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    current.stream = stream;
    const resumeError = await resume;
    if (resumeError) throw resumeError;
    await current.context.audioWorklet.addModule(new URL("./capture.mjs", import.meta.url));
    if (session !== current) return;

    const source = current.context.createMediaStreamSource(stream);
    const capture = new AudioWorkletNode(current.context, "capture");
    const silent = current.context.createGain();
    silent.gain.value = 0;
    capture.port.onmessage = (event) => processAudio(current, event.data);
    const interrupted = () => {
      if (session === current) stopSession("Microphone audio stopped. Start again to continue.");
    };
    capture.onprocessorerror = interrupted;
    stream.getAudioTracks().forEach((track) => track.addEventListener("ended", interrupted));
    if (isDrill) {
      Object.assign(current, {
        pair: [...practice.pair], good: 0, bad: 0, previous: 0.001, floor: 0.001,
        lastStrum: -Infinity, lastCorrect: null, fastest: null, blocks: [],
      });
      updateClock(duration);
      element("good").textContent = "0";
      element("bad").textContent = "0";
      showShapes();
      showPracticeRecords();
      const countdownUntil = performance.now() + countdownSeconds * 1000;
      let countdown = countdownSeconds;
      message.textContent = `Starting in ${countdown}`;
      current.timer = setInterval(() => {
        const now = performance.now();
        if (!current.active) {
          const remaining = Math.ceil((countdownUntil - now) / 1000);
          if (remaining > 0) {
            if (remaining !== countdown) {
              countdown = remaining;
              message.textContent = `Starting in ${countdown}`;
            }
            return;
          }
          current.audioStartsAt = current.context.currentTime;
          current.audioDeadline = current.audioStartsAt + duration;
          current.deadline = now + duration * 1000;
          current.active = true;
          showShapes(0);
          button.textContent = "Stop drill";
          message.textContent = "Strum the highlighted chord.";
        }
        updateClock(Math.max(0, (current.deadline - now) / 1000));
        if (now >= current.deadline && (!current.blocks.length || now > current.deadline + 350)) {
          finishDrill(current);
        }
      }, 50);
    } else {
      Object.assign(current, { recent: [], peaks: [], nextPitch: 0 });
      current.active = true;
      button.textContent = "Stop tuner";
      message.textContent = "";
      element("tuner-state").textContent = "Listening";
    }
    source.connect(capture).connect(silent).connect(current.context.destination);
  } catch (error) {
    if (session === current) stopSession(microphoneError(error));
  }
}

function renderHistory() {
  const selected = historyFilter.value;
  const options = [...new Set(practice.history.map((run) => pairName(run.pair)))].sort();
  historyFilter.replaceChildren(new Option("All chord pairs", ""), ...options.map((pair) => new Option(pair, pair)));
  historyFilter.value = options.includes(selected) ? selected : "";
  const runs = historyFilter.value
    ? practice.history.filter((run) => pairName(run.pair) === historyFilter.value) : practice.history;
  const { best, fastest } = recordsFor(runs);
  element("history-summary").hidden = !best;
  element("history-best").textContent = best ? `${best.good} good · ${best.bad} bad (${pairName(best.pair)})` : "";
  element("history-time").textContent = fastest ? `${timeLabel(fastest.fastest)} (${pairName(fastest.pair)})` : "—";
  element("history-message").textContent = storageError
    ? "Local storage is unavailable. These results may be lost when you close this page."
    : best ? "" : "No completed drills yet.";
  element("history-list").replaceChildren(...runs.map((run) => {
    const item = document.createElement("li");
    const heading = document.createElement("div");
    heading.className = "run-header";
    const pair = document.createElement("strong");
    pair.textContent = pairName(run.pair);
    const time = document.createElement("time");
    time.dateTime = run.date;
    time.textContent = dateLabel.format(new Date(run.date));
    heading.append(pair, time);
    const details = document.createElement("span");
    details.className = "run-meta";
    details.textContent = `${Math.max(0, run.good - 1)} changes · ${run.good} good · ${run.bad} bad · Clean change ${timeLabel(run.fastest)}`;
    item.append(heading, details);
    return item;
  }));
}

selectors.forEach((selector, index) => {
  selector.replaceChildren(...chordNames.map((name) => new Option(name, name)));
  selector.value = practice.pair[index];
  selector.addEventListener("change", () => {
    practice.pair[index] = selector.value;
    savePractice();
    showShapes();
    showPracticeRecords();
    element("drill-message").textContent = storageError ? "Chord selections could not be saved." : "";
  });
});

function toggleSession(mode) {
  if (!session) return startSession(mode);
  stopSession(mode === "drill" ? "Drill stopped. Only completed drills appear in history." : "");
}

drillButton.addEventListener("click", () => toggleSession("drill"));
tunerButton.addEventListener("click", () => toggleSession("tuner"));
historyFilter.addEventListener("change", renderHistory);
const navigation = Array.from(document.querySelectorAll("[data-view]"));
for (const button of navigation) {
  button.addEventListener("click", () => {
    if (button.hasAttribute("aria-current")) return;
    stopSession(session?.mode === "drill" ? "Drill stopped. Only completed drills appear in history." : "");
    for (const item of navigation) {
      const selected = item === button;
      if (selected) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
      element(item.dataset.view).hidden = !selected;
    }
    if (button.dataset.view === "history") renderHistory();
  });
}
window.addEventListener("pagehide", () => stopSession(""));
showShapes();
showPracticeRecords();

if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("./service-worker.js").catch(() => {});
}
