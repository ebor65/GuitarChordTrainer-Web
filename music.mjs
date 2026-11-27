// Pitch classes start at C. Shapes run from the low E string to the high e.
export const chords = {
  A: [[9, 1, 4], "x02220", "--123-"],
  A7: [[9, 1, 4, 7], "x02020", "--2-3-"],
  Am: [[9, 0, 4], "x02210", "--231-"],
  Ab: [[8, 0, 3], "xx1114", "--1114"],
  Bm: [[11, 2, 6], "x24432", "-13421"],
  B7: [[11, 3, 6, 9], "x21202", "-213-4"],
  C: [[0, 4, 7], "x32010", "-32-1-"],
  C7: [[0, 4, 7, 10], "x32310", "-3241-"],
  D: [[2, 6, 9], "xx0232", "---132"],
  D7: [[2, 6, 9, 0], "xx0212", "---213"],
  Dm: [[2, 5, 9], "xx0231", "---231"],
  E: [[4, 8, 11], "022100", "-231--"],
  E7: [[4, 8, 11, 2], "020100", "-2-1--"],
  Em: [[4, 7, 11], "022000", "-23---"],
  F: [[5, 9, 0], "133211", "134211"],
  F7: [[5, 9, 0, 3], "131211", "131211"],
  Fm: [[5, 8, 0], "133111", "134111"],
  "F#m": [[6, 9, 1], "xx4222", "--3111"],
  G: [[7, 11, 2], "320003", "21---3"],
  G7: [[7, 11, 2, 5], "320001", "32---1"],
};

export const guitarStrings = [
  ["E2", 40], ["A2", 45], ["D3", 50], ["G3", 55], ["B3", 59], ["E4", 64],
];

function mean(samples) {
  return samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
}

function fft(real, imaginary, inverse = false) {
  const size = real.length;
  for (let index = 1, reverse = 0; index < size; index++) {
    let bit = size >> 1;
    for (; reverse & bit; bit >>= 1) reverse ^= bit;
    reverse ^= bit;
    if (index < reverse) {
      [real[index], real[reverse]] = [real[reverse], real[index]];
      [imaginary[index], imaginary[reverse]] = [imaginary[reverse], imaginary[index]];
    }
  }
  for (let width = 2; width <= size; width *= 2) {
    const angle = (inverse ? 2 : -2) * Math.PI / width;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < size; start += width) {
      let rotationReal = 1;
      let rotationImaginary = 0;
      for (let offset = 0; offset < width / 2; offset++) {
        const left = start + offset;
        const right = left + width / 2;
        const productReal = real[right] * rotationReal - imaginary[right] * rotationImaginary;
        const productImaginary = real[right] * rotationImaginary + imaginary[right] * rotationReal;
        real[right] = real[left] - productReal;
        imaginary[right] = imaginary[left] - productImaginary;
        real[left] += productReal;
        imaginary[left] += productImaginary;
        const nextReal = rotationReal * stepReal - rotationImaginary * stepImaginary;
        rotationImaginary = rotationReal * stepImaginary + rotationImaginary * stepReal;
        rotationReal = nextReal;
      }
    }
  }
}

export function recognizeChord(samples, rate) {
  const size = 2 ** Math.ceil(Math.log2(4 * samples.length));
  const real = new Float64Array(size);
  const imaginary = new Float64Array(size);
  const average = mean(samples);
  for (let index = 0; index < samples.length; index++) {
    const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (samples.length - 1));
    real[index] = (samples[index] - average) * window;
  }
  fft(real, imaginary);

  const first = Math.ceil(75 * size / rate);
  const last = Math.floor(750 * size / rate);
  const magnitude = (index) => Math.hypot(real[index], imaginary[index]);
  const peaks = [];
  let strongest = 0;
  for (let index = first; index <= last; index++) {
    const power = magnitude(index);
    if (power > magnitude(index - 1) && power > magnitude(index + 1)) {
      peaks.push([index * rate / size, power]);
      strongest = Math.max(strongest, power);
    }
  }
  if (!strongest) return null;

  const chroma = new Float64Array(12);
  let total = 0;
  for (const [frequency, power] of peaks) {
    if (power < strongest * 0.08) continue;
    const note = Math.round(69 + 12 * Math.log2(frequency / 440));
    const weight = power / Math.sqrt(frequency / 100);
    chroma[note % 12] += weight;
    total += weight;
  }

  const ranked = Object.entries(chords).map(([name, [notes]]) => {
    const energy = notes.map((note) => chroma[note] / total);
    const [root, third, fifth, seventh] = energy;
    const sum = energy.reduce((a, b) => a + b, 0);
    const lowest = Math.min(...energy);
    if (seventh === undefined) return { name, score: sum + 1.5 * lowest, eligible: lowest >= 0.055 };
    // The open C7 shape omits the fifth. Require the root, third and seventh.
    if (seventh < 0.07 || Math.min(root, third) < 0.055) {
      return { name, score: -Infinity, eligible: false };
    }
    return { name, score: sum + 1.5 * Math.min(root, third, Math.max(fifth, seventh)), eligible: true };
  }).sort((a, b) => b.score - a.score);
  const [best, second] = ranked;
  return best.eligible && best.score - second.score >= 0.065 ? best.name : null;
}

export function estimatePitch(samples, rate) {
  const size = 2 ** Math.ceil(Math.log2(2 * samples.length));
  const real = new Float64Array(size);
  const imaginary = new Float64Array(size);
  const energy = new Float64Array(samples.length + 1);
  const average = mean(samples);
  for (let index = 0; index < samples.length; index++) {
    real[index] = samples[index] - average;
    energy[index + 1] = energy[index] + real[index] ** 2;
  }
  if (Math.sqrt(energy[samples.length] / samples.length) < 0.0015) return null;

  fft(real, imaginary);
  for (let index = 0; index < size; index++) real[index] = real[index] ** 2 + imaginary[index] ** 2;
  imaginary.fill(0);
  fft(real, imaginary, true);

  const first = Math.max(2, Math.floor(rate / 400));
  const last = Math.min(Math.floor(rate / 55), Math.floor(samples.length / 3));
  const normalized = new Float64Array(last + 1);
  normalized[0] = 1;
  let sum = 0;
  for (let lag = 1; lag <= last; lag++) {
    const difference = Math.max(0,
      energy[samples.length - lag] + energy[samples.length] - energy[lag] - 2 * real[lag] / size);
    sum += difference;
    normalized[lag] = difference * lag / Math.max(sum, 1e-12);
  }
  for (let lag = first; lag < last; lag++) {
    const left = normalized[lag - 1];
    const center = normalized[lag];
    const right = normalized[lag + 1];
    if (center < 0.18 && center <= left && center < right) {
      const curvature = left - 2 * center + right;
      const offset = curvature > 0 ? (left - right) / (2 * curvature) : 0;
      return rate / (lag + offset);
    }
  }
  return null;
}

export function concatenate(blocks) {
  const samples = new Float32Array(blocks.reduce((total, block) => total + block.length, 0));
  let offset = 0;
  for (const block of blocks) {
    samples.set(block, offset);
    offset += block.length;
  }
  return samples;
}
