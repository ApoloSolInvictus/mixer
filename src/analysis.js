const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "webm", "aiff", "aif"]);

export function isAudioFile(file) {
  const extension = (file.name.split(".").pop() || "").toLowerCase();
  return file.type.startsWith("audio/") || AUDIO_EXTENSIONS.has(extension);
}

export function formatTime(value) {
  if (!Number.isFinite(value) || value < 0) {
    return "00:00";
  }

  const totalSeconds = Math.floor(value);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes)) {
    return "--";
  }

  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export async function analyzeAudioBuffer(buffer) {
  await nextFrame();

  const envelope = buildLowTransientEnvelope(buffer);
  const kicks = pickKickCandidates(envelope, buffer.sampleRate);
  const tempo = estimateTempo(kicks, buffer.duration);
  const waveform = summarizeWaveform(buffer, 3200);
  const beatGrid = tempo.bpm ? buildBeatGrid(tempo.firstBeat, tempo.bpm, buffer.duration) : [];

  return {
    bpm: tempo.bpm,
    confidence: tempo.confidence,
    firstBeat: tempo.firstBeat,
    beatGrid,
    kicks: kicks.map((kick) => kick.time),
    waveform
  };
}

export function createDemoTrack(audioContext) {
  const bpm = 128;
  const bars = 24;
  const beats = bars * 4;
  const sampleRate = audioContext.sampleRate;
  const duration = (beats * 60) / bpm;
  const buffer = audioContext.createBuffer(2, Math.ceil(duration * sampleRate), sampleRate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  const beatLength = 60 / bpm;

  for (let beat = 0; beat < beats; beat += 1) {
    const time = beat * beatLength;
    addKick(left, sampleRate, time, beat % 4 === 0 ? 1 : 0.78);
    addKick(right, sampleRate, time, beat % 4 === 0 ? 0.9 : 0.72);

    if (beat % 4 === 1 || beat % 4 === 3) {
      addSnare(left, sampleRate, time, 0.22);
      addSnare(right, sampleRate, time + 0.003, 0.2);
    }

    addHat(left, sampleRate, time + beatLength / 2, 0.08);
    addHat(right, sampleRate, time + beatLength / 2 + 0.002, 0.09);
  }

  for (let sample = 0; sample < buffer.length; sample += 1) {
    const time = sample / sampleRate;
    const bass = Math.sin(2 * Math.PI * 48 * time) * 0.045 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.5 * time));
    const pad = Math.sin(2 * Math.PI * 220 * time) * 0.018 + Math.sin(2 * Math.PI * 330 * time) * 0.012;
    left[sample] = softClip(left[sample] + bass + pad);
    right[sample] = softClip(right[sample] + bass * 0.92 + pad * 0.85);
  }

  return {
    buffer,
    name: "Infiniti IA Demo Beat 128",
    folder: "Sintetico",
    size: buffer.length * 4 * buffer.numberOfChannels
  };
}

function buildLowTransientEnvelope(buffer) {
  const sampleRate = buffer.sampleRate;
  const windowSize = 1024;
  const frameCount = Math.max(1, Math.floor(buffer.length / windowSize));
  const envelope = new Float32Array(frameCount);
  const channelA = buffer.getChannelData(0);
  const channelB = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : channelA;
  const alpha = (2 * Math.PI * 165) / ((2 * Math.PI * 165) + sampleRate);
  let low = 0;
  let previous = 0;

  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * windowSize;
    const end = Math.min(start + windowSize, buffer.length);
    let lowEnergy = 0;
    let transientEnergy = 0;

    for (let sample = start; sample < end; sample += 1) {
      const mixed = (channelA[sample] + channelB[sample]) * 0.5;
      low += alpha * (mixed - low);
      lowEnergy += low * low;
      transientEnergy += Math.abs(mixed - previous);
      previous = mixed;
    }

    const length = Math.max(1, end - start);
    envelope[frame] = Math.sqrt(lowEnergy / length) * 0.82 + (transientEnergy / length) * 0.18;
  }

  normalize(envelope);
  return { data: envelope, frameDuration: windowSize / sampleRate };
}

function pickKickCandidates(envelopeInfo) {
  const { data, frameDuration } = envelopeInfo;
  const smooth = movingAverage(data, 18);
  const stats = getStats(data);
  const minGapFrames = Math.max(1, Math.round(0.19 / frameDuration));
  const kicks = [];
  let lastFrame = -Infinity;

  for (let index = 2; index < data.length - 2; index += 1) {
    const localPeak =
      data[index] > data[index - 1] &&
      data[index] >= data[index + 1] &&
      data[index] > data[index - 2] &&
      data[index] >= data[index + 2];

    const threshold = Math.max(stats.mean + stats.std * 0.85, smooth[index] * 1.42, 0.13);

    if (localPeak && data[index] > threshold && index - lastFrame >= minGapFrames) {
      kicks.push({
        time: index * frameDuration,
        strength: data[index]
      });
      lastFrame = index;
    }
  }

  return pruneWeakClusters(kicks);
}

function pruneWeakClusters(kicks) {
  if (kicks.length < 2) {
    return kicks;
  }

  const result = [];
  for (const kick of kicks) {
    const previous = result[result.length - 1];
    if (!previous || kick.time - previous.time > 0.11) {
      result.push(kick);
    } else if (kick.strength > previous.strength) {
      result[result.length - 1] = kick;
    }
  }
  return result;
}

function estimateTempo(kicks, duration) {
  if (kicks.length < 4) {
    return { bpm: null, confidence: 0, firstBeat: kicks[0]?.time || 0 };
  }

  const scores = new Map();
  const maxNeighbors = Math.min(18, kicks.length);

  for (let index = 0; index < kicks.length; index += 1) {
    for (let next = index + 1; next < Math.min(kicks.length, index + maxNeighbors); next += 1) {
      const interval = kicks[next].time - kicks[index].time;
      if (interval < 0.24 || interval > 2.4) {
        continue;
      }

      let bpm = 60 / interval;
      while (bpm < 78) bpm *= 2;
      while (bpm > 180) bpm /= 2;

      const bin = Math.round(bpm);
      const weight = (kicks[index].strength + kicks[next].strength) / Math.max(1, next - index);
      scores.set(bin, (scores.get(bin) || 0) + weight);
    }
  }

  if (!scores.size) {
    return { bpm: null, confidence: 0, firstBeat: kicks[0].time };
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [bestBpm, bestScore] = ranked[0];
  const refinedTempo = refineTempoFromPairs(kicks, bestBpm);
  const totalScore = ranked.reduce((sum, [, score]) => sum + score, 0);
  const confidence = Math.min(
    0.98,
    bestScore / Math.max(1, totalScore) +
      refinedTempo.confidenceBonus +
      Math.min(0.22, kicks.length / Math.max(1, duration) / 10)
  );
  const firstBeat = findBestGridAnchor(kicks, refinedTempo.bpm);

  return {
    bpm: refinedTempo.bpm,
    confidence,
    firstBeat
  };
}

function refineTempoFromPairs(kicks, coarseBpm) {
  const coarseInterval = 60 / coarseBpm;
  const candidates = [];
  const maxNeighbors = Math.min(64, kicks.length);

  for (let index = 0; index < kicks.length; index += 1) {
    for (let next = index + 1; next < Math.min(kicks.length, index + maxNeighbors); next += 1) {
      const interval = kicks[next].time - kicks[index].time;
      const beatSpan = Math.round(interval / coarseInterval);

      if (beatSpan < 1 || beatSpan > 32) {
        continue;
      }

      const bpm = (60 * beatSpan) / interval;
      const relativeError = Math.abs(bpm - coarseBpm) / coarseBpm;

      if (relativeError > 0.035) {
        continue;
      }

      const strength = kicks[index].strength + kicks[next].strength;
      const weight = (strength * Math.sqrt(beatSpan)) / (1 + relativeError * 80);
      candidates.push({ bpm, weight });
    }
  }

  if (candidates.length < 3) {
    return { bpm: roundBpm(coarseBpm), confidenceBonus: 0 };
  }

  const median = weightedMedian(candidates);
  let totalWeight = 0;
  let weightedBpm = 0;

  for (const candidate of candidates) {
    if (Math.abs(candidate.bpm - median) / median > 0.012) {
      continue;
    }

    totalWeight += candidate.weight;
    weightedBpm += candidate.bpm * candidate.weight;
  }

  if (totalWeight <= 0) {
    return { bpm: roundBpm(median), confidenceBonus: 0.04 };
  }

  return {
    bpm: roundBpm(weightedBpm / totalWeight),
    confidenceBonus: Math.min(0.12, candidates.length / 600)
  };
}

function weightedMedian(candidates) {
  const sorted = [...candidates].sort((a, b) => a.bpm - b.bpm);
  const totalWeight = sorted.reduce((sum, candidate) => sum + candidate.weight, 0);
  let running = 0;

  for (const candidate of sorted) {
    running += candidate.weight;
    if (running >= totalWeight / 2) {
      return candidate.bpm;
    }
  }

  return sorted[sorted.length - 1].bpm;
}

function findBestGridAnchor(kicks, bpm) {
  const interval = 60 / bpm;
  const firstKick = kicks[0]?.time || 0;
  const firstBarWindow = kicks.filter((kick) => kick.time < firstKick + interval * 16);

  if (!firstBarWindow.length) {
    return firstKick;
  }

  return firstBarWindow.reduce((best, kick) => {
    const score = scoreGridAnchor(kicks, kick.time, interval);
    if (score > best.score) {
      return { time: kick.time, score };
    }
    return best;
  }, { time: firstBarWindow[0].time, score: -Infinity }).time;
}

function scoreGridAnchor(kicks, anchor, interval) {
  const tolerance = Math.min(0.085, interval * 0.18);
  let score = 0;

  for (const kick of kicks) {
    const phase = modulo((kick.time - anchor) / interval, 1);
    const distance = Math.min(phase, 1 - phase) * interval;
    const closeness = Math.max(0, 1 - distance / tolerance);
    score += closeness * kick.strength;
  }

  return score - anchor * 0.002;
}

function buildBeatGrid(firstBeat, bpm, duration) {
  const interval = 60 / bpm;
  const grid = [];
  let time = firstBeat;
  let index = 0;

  while (time - interval >= 0) {
    time -= interval;
  }

  while (time <= duration + interval) {
    grid.push({ time, bar: index % 4 === 0 });
    time += interval;
    index += 1;
  }

  return grid;
}

function summarizeWaveform(buffer, bucketCount) {
  const channelA = buffer.getChannelData(0);
  const channelB = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : channelA;
  const peaks = new Float32Array(bucketCount);
  const valleys = new Float32Array(bucketCount);
  const samplesPerBucket = Math.max(1, Math.floor(buffer.length / bucketCount));

  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = bucket * samplesPerBucket;
    const end = bucket === bucketCount - 1 ? buffer.length : Math.min(buffer.length, start + samplesPerBucket);
    let min = 1;
    let max = -1;

    for (let sample = start; sample < end; sample += 1) {
      const value = (channelA[sample] + channelB[sample]) * 0.5;
      if (value < min) min = value;
      if (value > max) max = value;
    }

    peaks[bucket] = max;
    valleys[bucket] = min;
  }

  return { peaks, valleys };
}

function movingAverage(data, radius) {
  const output = new Float32Array(data.length);
  const prefix = new Float32Array(data.length + 1);

  for (let index = 0; index < data.length; index += 1) {
    prefix[index + 1] = prefix[index] + data[index];
  }

  for (let index = 0; index < data.length; index += 1) {
    const start = Math.max(0, index - radius);
    const end = Math.min(data.length, index + radius + 1);
    output[index] = (prefix[end] - prefix[start]) / Math.max(1, end - start);
  }

  return output;
}

function getStats(data) {
  let sum = 0;
  for (const value of data) sum += value;
  const mean = sum / Math.max(1, data.length);

  let variance = 0;
  for (const value of data) variance += (value - mean) ** 2;
  const std = Math.sqrt(variance / Math.max(1, data.length));

  return { mean, std };
}

function normalize(data) {
  let max = 0;
  for (const value of data) {
    if (value > max) max = value;
  }

  if (max <= 0) {
    return;
  }

  for (let index = 0; index < data.length; index += 1) {
    data[index] /= max;
  }
}

function modulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function roundBpm(value) {
  return Math.round(value * 100) / 100;
}

function addKick(channel, sampleRate, time, amount) {
  const start = Math.floor(time * sampleRate);
  const length = Math.floor(0.36 * sampleRate);

  for (let index = 0; index < length && start + index < channel.length; index += 1) {
    const t = index / sampleRate;
    const envelope = Math.exp(-t * 18);
    const pitch = 115 * Math.exp(-t * 22) + 42;
    channel[start + index] += Math.sin(2 * Math.PI * pitch * t) * envelope * amount;
  }
}

function addSnare(channel, sampleRate, time, amount) {
  const start = Math.floor(time * sampleRate);
  const length = Math.floor(0.18 * sampleRate);

  for (let index = 0; index < length && start + index < channel.length; index += 1) {
    const t = index / sampleRate;
    const envelope = Math.exp(-t * 24);
    const noise = randomSigned(index + start);
    channel[start + index] += (noise * 0.82 + Math.sin(2 * Math.PI * 185 * t) * 0.18) * envelope * amount;
  }
}

function addHat(channel, sampleRate, time, amount) {
  const start = Math.floor(time * sampleRate);
  const length = Math.floor(0.05 * sampleRate);

  for (let index = 0; index < length && start + index < channel.length; index += 1) {
    const t = index / sampleRate;
    const envelope = Math.exp(-t * 80);
    channel[start + index] += randomSigned(index * 17 + start) * envelope * amount;
  }
}

function randomSigned(seed) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return (value - Math.floor(value)) * 2 - 1;
}

function softClip(value) {
  return Math.tanh(value * 1.15) * 0.82;
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}
