export class WaveformView {
  constructor(canvas, options) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.getDeck = options.getDeck;
    this.onSeek = options.onSeek;
    this.viewWindow = 46;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
    this.bind();
  }

  bind() {
    this.canvas.addEventListener("pointerdown", (event) => {
      const deck = this.getDeck();
      if (!deck.track || !deck.duration) return;

      const rect = this.canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const time = this.mapPointToTime(x, y, rect.width, rect.height, deck);
      this.onSeek(time);
    });
  }

  resize() {
    const pixelRatio = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width * pixelRatio));
    const height = Math.max(1, Math.floor(rect.height * pixelRatio));

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  draw() {
    this.resize();
    const ctx = this.context;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const ratio = window.devicePixelRatio || 1;
    const deck = this.getDeck();

    ctx.clearRect(0, 0, width, height);
    drawBackground(ctx, width, height);

    if (!deck.track) {
      drawEmpty(ctx, width, height, "Carga una cancion");
      return;
    }

    if (!deck.track.analysis) {
      drawEmpty(ctx, width, height, deck.track.status === "analyzing" ? "Analizando audio" : "Preparando pista");
      return;
    }

    const mainHeight = height - 36 * ratio;
    const view = getVisibleWindow(deck, this.viewWindow);
    drawBeatGrid(ctx, deck, view, width, mainHeight, ratio);
    drawWaveform(ctx, deck, view, width, mainHeight);
    drawKickLines(ctx, deck, view, width, mainHeight, ratio);
    drawCue(ctx, deck, view, width, mainHeight, ratio);
    drawPlayhead(ctx, deck, view, width, mainHeight, ratio);
    drawOverview(ctx, deck, width, height, ratio);
  }

  mapPointToTime(x, y, width, height, deck) {
    const ratio = window.devicePixelRatio || 1;
    const overviewTop = height - 36;
    if (y >= overviewTop) {
      return (x / width) * deck.duration;
    }

    const view = getVisibleWindow(deck, this.viewWindow);
    return view.start + (x / width) * (view.end - view.start);
  }
}

function getVisibleWindow(deck, size) {
  const duration = deck.duration || 1;
  const windowSize = Math.min(duration, size / Math.max(0.8, deck.playbackRate || 1));
  let start = deck.position - windowSize * 0.5;

  if (start < 0) start = 0;
  if (start + windowSize > duration) start = Math.max(0, duration - windowSize);

  return { start, end: start + windowSize };
}

function drawBackground(ctx, width, height) {
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "#111113");
  gradient.addColorStop(0.5, "#171719");
  gradient.addColorStop(1, "#0c0c0e");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += width / 16) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
}

function drawEmpty(ctx, width, height, message) {
  ctx.fillStyle = "rgba(255,255,255,0.62)";
  ctx.font = `${Math.max(14, width / 72)}px Inter, Segoe UI, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(message, width / 2, height / 2);
}

function drawWaveform(ctx, deck, view, width, height) {
  const waveform = deck.track.analysis.waveform;
  const { peaks, valleys } = waveform;
  const duration = deck.duration || 1;
  const center = height * 0.5;
  const scale = height * 0.44;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();

  for (let x = 0; x < width; x += 1) {
    const time = view.start + (x / width) * (view.end - view.start);
    const index = Math.max(0, Math.min(peaks.length - 1, Math.floor((time / duration) * peaks.length)));
    const top = center + valleys[index] * scale;
    const bottom = center + peaks[index] * scale;
    const amp = Math.min(1, Math.abs(peaks[index] - valleys[index]));
    ctx.strokeStyle = amp > 0.68 ? "#ffbf4d" : amp > 0.36 ? "#26e0ff" : "#b8f7ff";
    ctx.globalAlpha = amp > 0.36 ? 0.94 : 0.58;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
  }

  const playedWidth = ((deck.position - view.start) / (view.end - view.start)) * width;
  ctx.globalCompositeOperation = "source-atop";
  ctx.fillStyle = "rgba(38, 224, 255, 0.16)";
  ctx.fillRect(0, 0, Math.max(0, playedWidth), height);
  ctx.restore();
}

function drawBeatGrid(ctx, deck, view, width, height, ratio) {
  const beatGrid = deck.track.analysis.beatGrid || [];
  ctx.save();

  for (const beat of beatGrid) {
    if (beat.time < view.start || beat.time > view.end) continue;
    const x = ((beat.time - view.start) / (view.end - view.start)) * width;
    ctx.strokeStyle = beat.bar ? "rgba(255, 191, 77, 0.52)" : "rgba(255, 255, 255, 0.13)";
    ctx.lineWidth = beat.bar ? 2 * ratio : 1 * ratio;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  ctx.restore();
}

function drawKickLines(ctx, deck, view, width, height, ratio) {
  const kicks = deck.track.analysis.kicks || [];
  ctx.save();
  ctx.strokeStyle = "rgba(255, 93, 93, 0.78)";
  ctx.lineWidth = 1.5 * ratio;

  for (const kick of kicks) {
    if (kick < view.start || kick > view.end) continue;
    const x = ((kick - view.start) / (view.end - view.start)) * width;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  ctx.restore();
}

function drawCue(ctx, deck, view, width, height, ratio) {
  if (deck.cue < view.start || deck.cue > view.end) return;
  const x = ((deck.cue - view.start) / (view.end - view.start)) * width;
  ctx.save();
  ctx.strokeStyle = "#72f27d";
  ctx.lineWidth = 2 * ratio;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, height);
  ctx.stroke();
  ctx.restore();
}

function drawPlayhead(ctx, deck, view, width, height, ratio) {
  const x = ((deck.position - view.start) / (view.end - view.start)) * width;
  ctx.save();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2 * ratio;
  ctx.shadowBlur = 16 * ratio;
  ctx.shadowColor = "rgba(255,255,255,0.7)";
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, height);
  ctx.stroke();
  ctx.restore();
}

function drawOverview(ctx, deck, width, height, ratio) {
  const top = height - 28 * ratio;
  const overviewHeight = 18 * ratio;
  const waveform = deck.track.analysis.waveform;
  const { peaks, valleys } = waveform;
  const center = top + overviewHeight / 2;
  const scale = overviewHeight * 0.48;

  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.fillRect(0, top - 5 * ratio, width, overviewHeight + 10 * ratio);

  for (let x = 0; x < width; x += 1) {
    const index = Math.max(0, Math.min(peaks.length - 1, Math.floor((x / width) * peaks.length)));
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.beginPath();
    ctx.moveTo(x, center + valleys[index] * scale);
    ctx.lineTo(x, center + peaks[index] * scale);
    ctx.stroke();
  }

  const progress = deck.duration ? deck.position / deck.duration : 0;
  ctx.fillStyle = "rgba(255, 191, 77, 0.24)";
  ctx.fillRect(0, top - 5 * ratio, progress * width, overviewHeight + 10 * ratio);

  const x = progress * width;
  ctx.strokeStyle = "#ffbf4d";
  ctx.lineWidth = 2 * ratio;
  ctx.beginPath();
  ctx.moveTo(x, top - 5 * ratio);
  ctx.lineTo(x, top + overviewHeight + 5 * ratio);
  ctx.stroke();
  ctx.restore();
}
