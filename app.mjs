import { chords, recognizeChord, concatenate } from "./music.mjs";
import { createSongPractice } from "./songs.mjs";
import { createStrumming } from "./rhythm-ui.mjs";
import { createTuner } from "./tuner.mjs";

const duration = 60;
const countdownSeconds = 3;
const storageKey = "guitar-chord-trainer-v1";
const element = (id) => document.getElementById(id);
const selectors = [element("chord-first"), element("chord-second")];
const shapeCards = [element("shape-first"), element("shape-second")];
const drillButton = element("drill-button");
const inputButton = element("check-input");
const timerOnly = element("timer-only");
const historyFilter = element("history-filter");
const chordNames = Object.keys(chords);
const pairName = (pair) => [...pair].sort().join(" ↔ ");
const timeLabel = (seconds) => seconds == null ? "—" : `${seconds.toFixed(2)} s`;
const dateLabel = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
let storageError = false;
let session;
const tuner = createTuner({
  element, input: () => session?.mode === "tuner" ? session : undefined,
  start: () => startInput("tuner"), stop: () => stopSession(),
});
function loadPractice() {
  const defaults = { pair: ["G", "C"], history: [] };
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey)) ?? {};
    const pair = Array.isArray(saved.pair) && saved.pair.length === 2 && saved.pair.every((chord) => chordNames.includes(chord))
      ? saved.pair : defaults.pair;
    return { pair, history: Array.isArray(saved.history) ? saved.history : [] };
  } catch {
    storageError = true;
    return defaults;
  }
}

const practice = loadPractice();
const songPractice = createSongPractice(element("songs"), () => stopSession(""));
const strumming = createStrumming(element("strumming"), () => stopSession(""), () => practice.pair);
const soundSelectors = document.querySelectorAll('[data-rhythm="sound"]');
for (const selector of soundSelectors) {
  selector.addEventListener("change", () => {
    for (const field of soundSelectors) field.value = selector.value;
  });
}

let activeShape = -1;

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
  const colors = getComputedStyle(canvas);
  const ink = colors.getPropertyValue(active ? "--diagram-active" : "--diagram-ink").trim();
  const fretColor = colors.getPropertyValue("--diagram-frets").trim();
  const fingerColor = colors.getPropertyValue("--diagram-finger").trim();
  const strings = Array.from({ length: 6 }, (_, index) => 36 + index * 33.6);
  const nut = 56;
  const spacing = 39;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineCap = "round";
  ctx.font = "20px system-ui";
  ctx.fillStyle = ink;
  ctx.strokeStyle = fretColor;
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
    const first = fingers.indexOf("1");
    const y = nut + (Number(frets[first]) - 0.5) * spacing;
    ctx.moveTo(strings[first], y);
    ctx.lineTo(strings[fingers.lastIndexOf("1")], y);
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
      ctx.fillStyle = fingerColor;
      ctx.fillText(finger, x, y + 1);
      description.push(`${name}, fret ${fret}, finger ${finger}`);
    }
  });
  canvas.setAttribute("aria-label", `${chord} chord. ${description.join("; ")}`);
}

function showShapes(active = -1) {
  activeShape = active;
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

function showInputPeak(current, peak, timestamp) {
  current.peaks.push(peak);
  if (current.peaks.length > 20) current.peaks.shift();
  if (timestamp < current.nextMeter) return false;
  current.nextMeter = timestamp + 0.1;
  const maxPeak = Math.max(...current.peaks);
  const db = 20 * Math.log10(Math.max(maxPeak, 1e-6));
  const isTuner = current.mode === "tuner";
  const label = element(isTuner ? "level-label" : "drill-level-label");
  const level = maxPeak >= 0.98 ? "Near clipping" : !isTuner && db < -52 ? "No detectable signal" :
    db < -40 ? "Low signal" : "Signal OK";
  element(isTuner ? "level" : "drill-level").value = Math.max(0, 60 + db);
  if (label.textContent !== level) label.textContent = level;
  return true;
}

function processAudio(current, { samples, timestamp }) {
  if (session !== current || !current.inputReady) return;
  if (current.mode === "tuner" && !tuner.capturing(current, timestamp)) return;
  let energy = 0;
  let peak = 0;
  for (const sample of samples) {
    energy += sample ** 2;
    peak = Math.max(peak, Math.abs(sample));
  }
  const update = showInputPeak(current, peak, timestamp);
  if (current.mode === "drill" && current.active) {
    processStrum(current, samples, timestamp, Math.sqrt(energy / samples.length));
  } else if (current.mode === "tuner") {
    tuner.capture(current, samples, timestamp, peak, update);
  }
}

function showDrillControls() {
  const [first, second] = practice.pair;
  const valid = first !== second;
  const running = session?.mode === "drill" || session?.mode === "timer";
  const checking = session?.mode === "check";
  element("pair-error").textContent = valid ? "" : "Choose two different chords";
  element("drill-instructions").textContent = valid ? `Play ${first} first, then alternate ${first} and ${second}.` : "";
  for (const selector of selectors) {
    selector.disabled = running;
    selector.setAttribute("aria-invalid", String(!valid));
  }
  drillButton.disabled = !valid || (checking && !session.inputReady);
  drillButton.textContent = running ? session.active ? "Stop drill" : "Cancel" : "Start drill";
  timerOnly.disabled = running;
  element("drill-scores").hidden = timerOnly.checked;
  inputButton.hidden = timerOnly.checked;
  inputButton.disabled = running;
  inputButton.textContent = checking ? session.inputReady ? "Stop input check" : "Cancel input check" : "Check input";
  element("drill-input").hidden = !checking && session?.mode !== "drill";
}

function stopSession(message = "") {
  if (!session) return;
  const current = session;
  session = undefined;
  clearInterval(current.timer);
  current.stream?.getTracks().forEach((track) => track.stop());
  if (current.context?.state !== "closed") current.context?.close().catch(() => {});
  if (current.mode === "tuner") {
    tuner.reset(message);
  } else {
    showDrillControls();
    showShapes();
    element("drill-level").value = 0;
    element("drill-level-label").textContent = "";
    element("drill-message").textContent = message;
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

function startDrillTimer(current) {
  const scored = current.mode === "drill";
  Object.assign(current, {
    pair: [...practice.pair], active: false, good: 0, bad: 0, previous: 0.001, floor: 0.001,
    lastStrum: -Infinity, lastCorrect: null, fastest: null, blocks: [],
  });
  updateClock(duration);
  if (scored) {
    element("good").textContent = "0";
    element("bad").textContent = "0";
    showPracticeRecords();
  }
  showShapes();
  showDrillControls();

  const message = element("drill-message");
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
      current.deadline = now + duration * 1000;
      current.active = true;
      if (scored) {
        current.audioStartsAt = current.context.currentTime;
        current.audioDeadline = current.audioStartsAt + duration;
        showShapes(0);
      }
      showDrillControls();
      message.textContent = scored ? "Strum the highlighted chord." : "Alternate the two chords at your own pace.";
    }
    updateClock(Math.max(0, (current.deadline - now) / 1000));
    if (now < current.deadline) return;
    if (!scored) stopSession("Time’s up.");
    else if (!current.blocks.length || now > current.deadline + 350) finishDrill(current);
  }, 50);
}

async function startInput(mode) {
  const isTuner = mode === "tuner";
  const message = element(isTuner ? "tuner-message" : "drill-message");
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    const text = "Microphone access requires an HTTPS page or localhost.";
    if (isTuner) tuner.reset(text);
    else message.textContent = text;
    return;
  }
  const current = { mode, peaks: [], recent: [], nextMeter: 0 };
  session = current;
  if (isTuner) tuner.connecting();
  else {
    showDrillControls();
    element("drill-level-label").textContent = "Connecting…";
  }
  message.textContent = "Waiting for microphone access…";

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
    source.connect(capture).connect(silent).connect(current.context.destination);
    current.inputReady = true;
    if (isTuner) {
      message.textContent = "";
      tuner.connected();
    } else {
      element("drill-level-label").textContent = "No detectable signal";
      if (mode === "drill") startDrillTimer(current);
      else {
        showDrillControls();
        message.textContent = "Strum your guitar to check the input level.";
      }
    }
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
    strumming.refreshChords();
    showShapes();
    showPracticeRecords();
    showDrillControls();
    element("drill-message").textContent = storageError ? "Chord selections could not be saved." : "";
  });
});

function stopDrill() {
  stopSession(session?.mode === "drill" ? "Drill stopped. Only completed drills appear in history." : "");
}

drillButton.addEventListener("click", () => {
  if (practice.pair[0] === practice.pair[1]) return;
  if (session?.mode === "check" && session.inputReady) {
    session.mode = "drill";
    startDrillTimer(session);
  } else if (session) {
    stopDrill();
  } else if (timerOnly.checked) {
    session = { mode: "timer" };
    startDrillTimer(session);
  } else {
    void startInput("drill");
  }
});
inputButton.addEventListener("click", () => {
  if (session?.mode === "check") stopSession();
  else if (!session && !timerOnly.checked) void startInput("check");
});
timerOnly.addEventListener("change", () => {
  if (session?.mode === "check") stopSession();
  element("drill-message").textContent = "";
  showDrillControls();
});
historyFilter.addEventListener("change", renderHistory);

function showPracticeMode(useStrumming) {
  if (useStrumming) stopDrill();
  else strumming.stop();
  element("chord-practice").hidden = useStrumming;
  element("strumming").hidden = !useStrumming;
}

element("show-chords").addEventListener("change", () => showPracticeMode(false));
element("show-strumming").addEventListener("change", () => showPracticeMode(true));
showPracticeMode(element("show-strumming").checked);

function stopRhythm() {
  songPractice.stop();
  strumming.stop();
}
const navigation = Array.from(document.querySelectorAll("[data-view]"));
for (const button of navigation) {
  button.addEventListener("click", () => {
    if (button.hasAttribute("aria-current")) return;
    stopSession(session?.mode === "drill" ? "Drill stopped. Only completed drills appear in history." : "");
    stopRhythm();
    tuner.reset();
    for (const item of navigation) {
      const selected = item === button;
      if (selected) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
      element(item.dataset.view).hidden = !selected;
    }
    if (button.dataset.view === "history") renderHistory();
  });
}
window.addEventListener("pagehide", () => { stopSession(""); stopRhythm(); tuner.reset(); });
const themeToggle = element("dark-mode");
const themeKey = "guitar-chord-trainer-theme";
let dark = false;
try { dark = localStorage.getItem(themeKey) === "dark"; } catch {}
function showTheme() {
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  themeToggle.setAttribute("aria-pressed", String(dark));
  showShapes(activeShape);
}
themeToggle.addEventListener("click", () => {
  dark = !dark;
  try { localStorage.setItem(themeKey, dark ? "dark" : "light"); } catch {}
  showTheme();
});
showTheme();
showPracticeRecords();
showDrillControls();

if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("./service-worker.js").catch(() => {});
}
