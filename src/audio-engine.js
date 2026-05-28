export class AudioEngine extends EventTarget {
  constructor() {
    super();
    this.context = null;
    this.masterGain = null;
    this.analyser = null;
    this.meterBuffer = null;
    this.crossfader = 0;
    this.lastSyncedDeckId = null;
    this.decks = new Map([
      ["A", createDeckState("A")],
      ["B", createDeckState("B")]
    ]);
  }

  async ensure() {
    if (!this.context) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.context = new AudioContextClass();
      this.masterGain = this.context.createGain();
      this.masterGain.gain.value = 0.92;
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 1024;
      this.meterBuffer = new Uint8Array(this.analyser.fftSize);
      this.masterGain.connect(this.analyser);
      this.analyser.connect(this.context.destination);

      for (const deck of this.decks.values()) {
        this.createDeckNodes(deck);
      }
    }

    if (this.context.state === "suspended") {
      await this.context.resume();
    }

    return this.context;
  }

  async decode(arrayBuffer) {
    const context = await this.ensure();
    return context.decodeAudioData(arrayBuffer.slice(0));
  }

  createDeckNodes(deck) {
    deck.low = this.context.createBiquadFilter();
    deck.low.type = "lowshelf";
    deck.low.frequency.value = 260;

    deck.mid = this.context.createBiquadFilter();
    deck.mid.type = "peaking";
    deck.mid.frequency.value = 1100;
    deck.mid.Q.value = 0.9;

    deck.high = this.context.createBiquadFilter();
    deck.high.type = "highshelf";
    deck.high.frequency.value = 3600;

    deck.gainNode = this.context.createGain();
    deck.low.connect(deck.mid);
    deck.mid.connect(deck.high);
    deck.high.connect(deck.gainNode);
    deck.gainNode.connect(this.masterGain);
    this.applyDeckTone(deck);
    this.applyCrossfader();
  }

  loadDeck(deckId, track) {
    const deck = this.decks.get(deckId);
    this.killSource(deck);
    deck.track = track;
    deck.buffer = track.buffer;
    deck.playing = false;
    deck.offset = 0;
    deck.startOffset = 0;
    deck.startedAt = 0;
    deck.playbackRate = 1;
    deck.tempoPercent = 0;
    deck.cue = track.analysis?.firstBeat || 0;
    this.dispatch(deckId);
  }

  clearDeck(deckId) {
    const deck = this.decks.get(deckId);
    if (!deck) return;

    this.killSource(deck);
    deck.track = null;
    deck.buffer = null;
    deck.playing = false;
    deck.offset = 0;
    deck.startOffset = 0;
    deck.startedAt = 0;
    deck.playbackRate = 1;
    deck.tempoPercent = 0;
    deck.cue = 0;
    this.dispatch(deckId);
  }

  async play(deckId) {
    const deck = this.decks.get(deckId);
    if (!deck?.buffer) return;
    await this.ensure();

    if (deck.playing) {
      this.pause(deckId);
      return;
    }

    const offset = Math.min(deck.offset || 0, Math.max(0, deck.buffer.duration - 0.02));
    this.startDeckSource(deck, offset);
    this.dispatch(deckId);
  }

  startDeckSource(deck, offset) {
    const source = this.context.createBufferSource();
    source.buffer = deck.buffer;
    source.playbackRate.value = deck.playbackRate;
    source.connect(deck.low);
    source.onended = () => {
      if (deck.source === source && this.getPosition(deck.id) >= deck.buffer.duration - 0.08) {
        deck.playing = false;
        deck.offset = 0;
        deck.startOffset = 0;
        deck.source = null;
        this.dispatch(deck.id);
      }
    };

    deck.source = source;
    deck.playing = true;
    deck.startedAt = this.context.currentTime;
    deck.startOffset = offset;
    deck.offset = offset;
    source.start(0, offset);
  }

  pause(deckId) {
    const deck = this.decks.get(deckId);
    if (!deck?.playing) return;

    deck.offset = this.getPosition(deckId);
    deck.startOffset = deck.offset;
    deck.playing = false;
    this.killSource(deck);
    this.dispatch(deckId);
  }

  stop(deckId) {
    const deck = this.decks.get(deckId);
    if (!deck) return;

    deck.playing = false;
    deck.offset = 0;
    deck.startOffset = 0;
    this.killSource(deck);
    this.dispatch(deckId);
  }

  seek(deckId, time) {
    const deck = this.decks.get(deckId);
    if (!deck?.buffer) return;

    const wasPlaying = deck.playing;
    deck.offset = clamp(time, 0, Math.max(0, deck.buffer.duration - 0.02));
    deck.startOffset = deck.offset;

    if (wasPlaying) {
      this.killSource(deck);
      this.startDeckSource(deck, deck.offset);
      this.dispatch(deckId);
      return;
    }

    this.dispatch(deckId);
  }

  setCue(deckId) {
    const deck = this.decks.get(deckId);
    if (!deck?.buffer) return;
    deck.cue = this.getPosition(deckId);
    this.dispatch(deckId);
  }

  jumpCue(deckId) {
    const deck = this.decks.get(deckId);
    if (!deck?.buffer) return;
    this.seek(deckId, deck.cue || 0);
  }

  setTempo(deckId, percent) {
    const deck = this.decks.get(deckId);
    if (!deck) return;

    const nextRate = Math.max(0.5, 1 + percent / 100);
    if (deck.playing) {
      deck.offset = this.getPosition(deckId);
      deck.startOffset = deck.offset;
      deck.startedAt = this.context.currentTime;
      deck.source.playbackRate.setTargetAtTime(nextRate, this.context.currentTime, 0.02);
    }

    deck.playbackRate = nextRate;
    deck.tempoPercent = percent;
    this.dispatch(deckId);
  }

  syncDeck(deckId) {
    const deck = this.decks.get(deckId);
    const other = this.decks.get(deckId === "A" ? "B" : "A");
    const sourceBpm = deck?.track?.analysis?.bpm;
    const targetBpm = other?.track?.analysis?.bpm;

    if (!sourceBpm || !targetBpm) {
      return null;
    }

    const rawTargetRate = (targetBpm * other.playbackRate) / sourceBpm;
    const targetRate = clamp(rawTargetRate, 0.88, 1.12);
    const tempo = (targetRate - 1) * 100;
    this.setTempo(deckId, tempo);
    this.lastSyncedDeckId = deckId;
    const alignment = this.alignBeatPhase(deckId, other.id);

    return {
      tempo,
      aligned: Boolean(alignment),
      phaseShift: alignment?.phaseShift || 0,
      limited: Math.abs(rawTargetRate - targetRate) > 0.001
    };
  }

  fineSyncPhase(deckId = this.getPreferredPhaseDeckId()) {
    const phaseInfo = this.getPhaseInfo();
    if (!phaseInfo || !deckId) {
      return null;
    }

    const deck = this.decks.get(deckId);
    const sourceAnalysis = deck?.track?.analysis;
    if (!deck?.buffer || !sourceAnalysis?.bpm) {
      return null;
    }

    const interval = 60 / sourceAnalysis.bpm;
    const position = this.getPosition(deckId);
    const phaseShift = deckId === "A" ? -phaseInfo.diff * interval : phaseInfo.diff * interval;
    const finalPosition = clamp(position + phaseShift, 0, Math.max(0, deck.buffer.duration - 0.02));

    this.lastSyncedDeckId = deckId;
    this.seek(deckId, finalPosition);

    return {
      deckId,
      phaseBefore: phaseInfo.diff,
      phaseAfter: this.getPhaseInfo()?.diff || 0,
      phaseShift: finalPosition - position
    };
  }

  getPreferredPhaseDeckId() {
    if (this.lastSyncedDeckId && this.decks.get(this.lastSyncedDeckId)?.buffer) {
      return this.lastSyncedDeckId;
    }

    const deckA = this.decks.get("A");
    const deckB = this.decks.get("B");
    if (deckA.playing && deckB.playing) {
      return deckB.startedAt >= deckA.startedAt ? "B" : "A";
    }

    if (deckB.buffer) return "B";
    if (deckA.buffer) return "A";
    return null;
  }

  alignBeatPhase(deckId, targetDeckId) {
    const deck = this.decks.get(deckId);
    const targetDeck = this.decks.get(targetDeckId);
    const sourceAnalysis = deck?.track?.analysis;
    const targetAnalysis = targetDeck?.track?.analysis;

    if (!deck?.buffer || !targetDeck?.buffer || !sourceAnalysis?.bpm || !targetAnalysis?.bpm) {
      return null;
    }

    const sourceInterval = 60 / sourceAnalysis.bpm;
    const targetInterval = 60 / targetAnalysis.bpm;
    const sourcePosition = this.getPosition(deckId);
    const targetPosition = this.getPosition(targetDeckId);
    const sourceFirstBeat = sourceAnalysis.firstBeat || 0;
    const targetFirstBeat = targetAnalysis.firstBeat || 0;
    const targetPhase = modulo((targetPosition - targetFirstBeat) / targetInterval, 1);
    const beatIndex = Math.round((sourcePosition - sourceFirstBeat) / sourceInterval - targetPhase);
    const alignedPosition = nearestValidBeatPhase({
      beatIndex,
      duration: deck.buffer.duration,
      firstBeat: sourceFirstBeat,
      interval: sourceInterval,
      phase: targetPhase,
      position: sourcePosition
    });

    if (!Number.isFinite(alignedPosition)) {
      return null;
    }

    const finalPosition = clamp(alignedPosition, 0, Math.max(0, deck.buffer.duration - 0.02));
    const phaseShift = finalPosition - sourcePosition;

    if (Math.abs(phaseShift) > 0.006) {
      this.seek(deckId, finalPosition);
    } else {
      this.dispatch(deckId);
    }

    return {
      phaseShift,
      position: finalPosition,
      targetPhase
    };
  }

  getPhaseInfo() {
    const deckA = this.decks.get("A");
    const deckB = this.decks.get("B");
    if (!deckA?.track?.analysis?.bpm || !deckB?.track?.analysis?.bpm) {
      return null;
    }

    const audioTime = this.context?.currentTime || 0;
    const phaseA = this.getDeckPhase(deckA, audioTime);
    const phaseB = this.getDeckPhase(deckB, audioTime);
    const diff = normalizePhaseDifference(phaseA - phaseB);

    return {
      diff,
      phaseA,
      phaseB,
      percent: Math.abs(diff) < 0.0005 ? 0 : Math.round(diff * 100)
    };
  }

  getDeckPhase(deck, audioTime) {
    const analysis = deck.track.analysis;
    const interval = 60 / analysis.bpm;
    const firstBeat = analysis.firstBeat || 0;
    const position = this.getDeckPositionAt(deck, audioTime);
    return modulo((position - firstBeat) / interval, 1);
  }

  getDeckPositionAt(deck, audioTime) {
    if (!deck.buffer) return 0;
    if (!deck.playing || !this.context) {
      return deck.offset || 0;
    }

    const elapsed = (audioTime - deck.startedAt) * deck.playbackRate;
    return Math.min(deck.buffer.duration, deck.startOffset + elapsed);
  }

  setDeckControl(deckId, control, value) {
    const deck = this.decks.get(deckId);
    if (!deck) return;

    if (control === "gain") {
      deck.gain = value;
      this.applyCrossfader();
      return;
    }

    if (control === "low" || control === "mid" || control === "high") {
      deck[`${control}Gain`] = value;
      this.applyDeckTone(deck);
    }
  }

  setMasterGain(value) {
    if (!this.masterGain) return;
    this.masterGain.gain.setTargetAtTime(value, this.context.currentTime, 0.02);
  }

  setCrossfader(value) {
    this.crossfader = value;
    this.applyCrossfader();
  }

  getPosition(deckId) {
    const deck = this.decks.get(deckId);
    if (!deck?.buffer) return 0;

    if (!deck.playing || !this.context) {
      return deck.offset || 0;
    }

    const elapsed = (this.context.currentTime - deck.startedAt) * deck.playbackRate;
    return Math.min(deck.buffer.duration, deck.startOffset + elapsed);
  }

  getDeckSnapshot(deckId) {
    const deck = this.decks.get(deckId);
    return {
      id: deck.id,
      track: deck.track,
      buffer: deck.buffer,
      playing: deck.playing,
      position: this.getPosition(deckId),
      duration: deck.buffer?.duration || 0,
      tempoPercent: deck.tempoPercent,
      playbackRate: deck.playbackRate,
      cue: deck.cue || 0
    };
  }

  getMasterLevel() {
    if (!this.analyser || !this.meterBuffer) {
      return 0;
    }

    this.analyser.getByteTimeDomainData(this.meterBuffer);
    let sum = 0;
    for (const value of this.meterBuffer) {
      const centered = (value - 128) / 128;
      sum += centered * centered;
    }

    return Math.min(1, Math.sqrt(sum / this.meterBuffer.length) * 2.8);
  }

  killSource(deck) {
    if (!deck.source) return;
    const source = deck.source;
    deck.source = null;
    source.onended = null;
    try {
      source.stop();
    } catch {
      // Already stopped by the browser audio thread.
    }
  }

  applyDeckTone(deck) {
    if (!deck.low) return;
    deck.low.gain.setTargetAtTime(deck.lowGain, this.context.currentTime, 0.02);
    deck.mid.gain.setTargetAtTime(deck.midGain, this.context.currentTime, 0.02);
    deck.high.gain.setTargetAtTime(deck.highGain, this.context.currentTime, 0.02);
  }

  applyCrossfader() {
    if (!this.context) return;
    const position = (this.crossfader + 1) / 2;
    const deckA = this.decks.get("A");
    const deckB = this.decks.get("B");
    const gainA = Math.cos(position * Math.PI * 0.5) * deckA.gain;
    const gainB = Math.sin(position * Math.PI * 0.5) * deckB.gain;

    if (deckA.gainNode) {
      deckA.gainNode.gain.setTargetAtTime(gainA, this.context.currentTime, 0.025);
    }
    if (deckB.gainNode) {
      deckB.gainNode.gain.setTargetAtTime(gainB, this.context.currentTime, 0.025);
    }
  }

  dispatch(deckId) {
    this.dispatchEvent(new CustomEvent("deckchange", { detail: { deckId } }));
  }
}

function createDeckState(id) {
  return {
    id,
    track: null,
    buffer: null,
    source: null,
    playing: false,
    offset: 0,
    startOffset: 0,
    startedAt: 0,
    playbackRate: 1,
    tempoPercent: 0,
    cue: 0,
    gain: 0.9,
    lowGain: 0,
    midGain: 0,
    highGain: 0,
    low: null,
    mid: null,
    high: null,
    gainNode: null
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function modulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function normalizePhaseDifference(value) {
  let diff = modulo(value + 0.5, 1) - 0.5;
  if (diff === -0.5) {
    diff = 0.5;
  }
  return diff;
}

function nearestValidBeatPhase({ beatIndex, duration, firstBeat, interval, phase, position }) {
  let bestPosition = null;
  let bestDistance = Infinity;

  for (let offset = -8; offset <= 8; offset += 1) {
    const candidate = firstBeat + (beatIndex + offset + phase) * interval;
    if (candidate < 0 || candidate > duration) {
      continue;
    }

    const distance = Math.abs(candidate - position);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestPosition = candidate;
    }
  }

  if (bestPosition !== null) {
    return bestPosition;
  }

  const wrappedBeat = Math.max(0, Math.round((position - firstBeat) / interval));
  return firstBeat + (wrappedBeat + phase) * interval;
}
