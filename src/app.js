import { AudioEngine } from "./audio-engine.js";
import { WaveformView } from "./waveform.js";
import {
  analyzeAudioBuffer,
  createDemoTrack,
  formatFileSize,
  formatTime,
  isAudioFile
} from "./analysis.js";

const engine = new AudioEngine();
const tracks = [];
const preparing = new Map();
const EQ_RESET_CONTROLS = new Set(["low", "mid", "high"]);

const elements = {
  app: document.querySelector("#app"),
  openFolderButton: document.querySelector("#openFolderButton"),
  openFilesButton: document.querySelector("#openFilesButton"),
  demoButton: document.querySelector("#demoButton"),
  clearButton: document.querySelector("#clearButton"),
  filePicker: document.querySelector("#filePicker"),
  folderPicker: document.querySelector("#folderPicker"),
  libraryBody: document.querySelector("#libraryBody"),
  libraryCount: document.querySelector("#libraryCount"),
  searchInput: document.querySelector("#searchInput"),
  toast: document.querySelector("#toast"),
  masterGain: document.querySelector("#masterGain"),
  crossfader: document.querySelector("#crossfader"),
  masterMeter: document.querySelector("#masterMeter"),
  phaseLights: document.querySelector("#phaseLights"),
  phaseText: document.querySelector("#phaseText"),
  deck: {
    A: collectDeckElements("A"),
    B: collectDeckElements("B")
  }
};

const waveforms = {
  A: new WaveformView(document.querySelector("#waveA"), {
    getDeck: () => engine.getDeckSnapshot("A"),
    onSeek: (time) => engine.seek("A", time)
  }),
  B: new WaveformView(document.querySelector("#waveB"), {
    getDeck: () => engine.getDeckSnapshot("B"),
    onSeek: (time) => engine.seek("B", time)
  })
};

wireEvents();
renderLibrary();
requestAnimationFrame(tick);

window.infinitiDjLab = {
  createDemo,
  tracks: () => tracks.map((track) => ({ name: track.name, bpm: track.analysis?.bpm, kicks: track.analysis?.kicks.length || 0 }))
};

function collectDeckElements(deckId) {
  return {
    root: document.querySelector(`.deck[data-deck="${deckId}"]`),
    title: document.querySelector(`#deck${deckId}Title`),
    artist: document.querySelector(`#deck${deckId}Artist`),
    bpm: document.querySelector(`#deck${deckId}Bpm`),
    time: document.querySelector(`#deck${deckId}Time`),
    tempo: document.querySelector(`#deck${deckId}Tempo`),
    gain: document.querySelector(`#deck${deckId}Gain`),
    low: document.querySelector(`#deck${deckId}Low`),
    mid: document.querySelector(`#deck${deckId}Mid`),
    high: document.querySelector(`#deck${deckId}High`)
  };
}

function wireEvents() {
  elements.openFolderButton.addEventListener("click", openFolder);
  elements.openFilesButton.addEventListener("click", () => elements.filePicker.click());
  elements.demoButton.addEventListener("click", createDemo);
  elements.clearButton.addEventListener("click", clearAll);
  elements.filePicker.addEventListener("change", () => addFiles([...elements.filePicker.files], "Archivos"));
  elements.folderPicker.addEventListener("change", () => addFiles([...elements.folderPicker.files], "Carpeta"));
  elements.searchInput.addEventListener("input", renderLibrary);
  elements.masterGain.addEventListener("input", () => engine.setMasterGain(Number(elements.masterGain.value)));
  elements.crossfader.addEventListener("input", () => engine.setCrossfader(Number(elements.crossfader.value)));
  elements.phaseLights.addEventListener("dblclick", fineSyncPhase);
  elements.phaseLights.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      fineSyncPhase();
    }
  });

  elements.libraryBody.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-load-deck]");
    if (!button) return;
    await loadTrackToDeck(button.dataset.trackId, button.dataset.loadDeck);
  });

  document.querySelectorAll(".deck").forEach((deckElement) => {
    const deckId = deckElement.dataset.deck;

    deckElement.addEventListener("click", async (event) => {
      const actionButton = event.target.closest("button[data-action]");
      if (!actionButton) return;
      await handleDeckAction(deckId, actionButton.dataset.action);
    });

    deckElement.querySelectorAll("input[data-control]").forEach((input) => {
      input.addEventListener("input", () => handleDeckControl(deckId, input.dataset.control, Number(input.value)));
      if (EQ_RESET_CONTROLS.has(input.dataset.control)) {
        input.title = "Doble click para volver a 0 dB";
      }
      input.closest("label")?.addEventListener("dblclick", () => resetDeckControl(deckId, input));
    });
  });

  window.addEventListener("dragover", (event) => {
    event.preventDefault();
    elements.app.classList.add("is-dropping");
  });

  window.addEventListener("dragleave", () => elements.app.classList.remove("is-dropping"));
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    elements.app.classList.remove("is-dropping");
    addFiles([...event.dataTransfer.files], "Drop");
  });

  engine.addEventListener("deckchange", (event) => {
    updateDeckControls(event.detail.deckId);
  });
}

async function openFolder() {
  if ("showDirectoryPicker" in window) {
    try {
      showToast("Selecciona el folder de musica en tu computadora");
      const directory = await window.showDirectoryPicker({ mode: "read" });
      const entries = await collectDirectoryFiles(directory);
      addFileEntries(entries);
      return;
    } catch (error) {
      if (error.name !== "AbortError") {
        showToast(`No se pudo abrir la carpeta: ${error.message}`);
      }
      return;
    }
  }

  elements.folderPicker.click();
}

async function collectDirectoryFiles(directoryHandle, folder = directoryHandle.name) {
  const entries = [];

  for await (const [, handle] of directoryHandle.entries()) {
    if (handle.kind === "file") {
      const file = await handle.getFile();
      if (isAudioFile(file)) {
        entries.push({ file, folder });
      }
    }

    if (handle.kind === "directory") {
      const nested = await collectDirectoryFiles(handle, `${folder}/${handle.name}`);
      entries.push(...nested);
    }
  }

  return entries;
}

function addFiles(files, source) {
  const entries = files
    .filter(isAudioFile)
    .map((file) => ({
      file,
      folder: getFolderName(file, source)
    }));

  addFileEntries(entries);
  elements.filePicker.value = "";
  elements.folderPicker.value = "";
}

function addFileEntries(entries) {
  let added = 0;

  for (const entry of entries) {
    const key = getTrackKey(entry.file, entry.folder);
    if (tracks.some((track) => track.key === key)) {
      continue;
    }

    tracks.push({
      id: createId(),
      key,
      file: entry.file,
      name: cleanTrackName(entry.file.name),
      folder: entry.folder,
      size: entry.file.size,
      status: "ready",
      duration: 0,
      buffer: null,
      analysis: null,
      error: ""
    });
    added += 1;
  }

  renderLibrary();
  showToast(added ? `${added} canciones agregadas a la libreria` : "No encontre canciones nuevas");
}

async function createDemo() {
  await engine.ensure();
  const demo = createDemoTrack(engine.context);
  const track = {
    id: createId(),
    key: `demo-${Date.now()}`,
    file: null,
    name: demo.name,
    folder: demo.folder,
    size: demo.size,
    status: "analyzing",
    duration: demo.buffer.duration,
    buffer: demo.buffer,
    analysis: null,
    error: ""
  };

  tracks.unshift(track);
  renderLibrary();
  showToast("Analizando Demo beat 128 BPM");
  await prepareTrack(track);
  await loadTrackToDeck(track.id, "A");
}

async function loadTrackToDeck(trackId, deckId) {
  const track = tracks.find((item) => item.id === trackId);
  if (!track) return;

  try {
    showToast(`Cargando ${track.name} en Deck ${deckId}`);
    const prepared = await prepareTrack(track);
    engine.loadDeck(deckId, prepared);
    resetDeckTempoControl(deckId);
    updateDeckControls(deckId);
    showToast(`${track.name} listo en Deck ${deckId}`);
  } catch (error) {
    showToast(`No pude leer esa cancion: ${error.message}`);
  }
}

async function prepareTrack(track) {
  if (track.buffer && track.analysis) {
    return track;
  }

  if (preparing.has(track.id)) {
    return preparing.get(track.id);
  }

  const task = (async () => {
    track.status = track.buffer ? "analyzing" : "decoding";
    renderLibrary();

    if (!track.buffer) {
      const arrayBuffer = await track.file.arrayBuffer();
      track.buffer = await engine.decode(arrayBuffer);
      track.duration = track.buffer.duration;
    }

    track.status = "analyzing";
    renderLibrary();

    track.analysis = await analyzeAudioBuffer(track.buffer);
    track.duration = track.buffer.duration;
    track.status = "analyzed";
    renderLibrary();
    return track;
  })()
    .catch((error) => {
      track.status = "error";
      track.error = error.message;
      renderLibrary();
      throw error;
    })
    .finally(() => preparing.delete(track.id));

  preparing.set(track.id, task);
  return task;
}

async function handleDeckAction(deckId, action) {
  if (action === "play") {
    await engine.play(deckId);
    return;
  }

  if (action === "stop") {
    engine.stop(deckId);
    return;
  }

  if (action === "set-cue") {
    engine.setCue(deckId);
    showToast(`Cue marcado en Deck ${deckId}`);
    return;
  }

  if (action === "cue") {
    engine.jumpCue(deckId);
    return;
  }

  if (action === "sync") {
    const result = engine.syncDeck(deckId);
    if (result === null) {
      showToast("Carga y analiza ambos decks para usar SYNC");
      return;
    }
    setTempoInput(deckId, result.tempo);
    showToast(getSyncMessage(deckId, result));
  }
}

function resetDeckControl(deckId, input) {
  const control = input.dataset.control;
  if (!EQ_RESET_CONTROLS.has(control)) {
    return;
  }

  input.value = "0";
  handleDeckControl(deckId, control, 0);
  showToast(`Deck ${deckId} ${control.toUpperCase()} devuelto a 0 dB`);
}

function fineSyncPhase() {
  const result = engine.fineSyncPhase();
  if (!result) {
    showToast("Carga y analiza ambos decks para centrar la fase");
    return;
  }

  updatePhaseMeter();
  const shift = Math.round(Math.abs(result.phaseShift) * 1000);
  const before = Math.round(result.phaseBefore * 100);
  showToast(`Fase exacta 0%: Deck ${result.deckId} ajustado ${shift} ms desde ${before}%`);
}

function handleDeckControl(deckId, control, value) {
  if (control === "tempo") {
    engine.setTempo(deckId, value);
    elements.deck[deckId].tempo.textContent = formatPercent(value);
    return;
  }

  engine.setDeckControl(deckId, control, value);
  const target = elements.deck[deckId][control];
  if (target) {
    target.textContent = control === "gain" ? `${Math.round(value * 100)}%` : `${value.toFixed(value % 1 ? 1 : 0)} dB`;
  }
}

function renderLibrary() {
  const query = elements.searchInput.value.trim().toLowerCase();
  const filtered = tracks.filter((track) => {
    if (!query) return true;
    const bpm = track.analysis?.bpm ? String(track.analysis.bpm) : "";
    return `${track.name} ${track.folder} ${bpm}`.toLowerCase().includes(query);
  });

  elements.libraryCount.textContent = `${tracks.length} ${tracks.length === 1 ? "cancion" : "canciones"}`;
  elements.libraryBody.replaceChildren();

  if (!filtered.length) {
    const row = document.createElement("tr");
    row.className = "empty-row";
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.textContent = tracks.length ? "No hay resultados con ese filtro." : "Abre una carpeta del escritorio o prueba el Demo beat.";
    row.append(cell);
    elements.libraryBody.append(row);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const track of filtered) {
    fragment.append(createTrackRow(track));
  }
  elements.libraryBody.append(fragment);
}

function createTrackRow(track) {
  const row = document.createElement("tr");
  row.dataset.trackId = track.id;

  const nameCell = document.createElement("td");
  const title = document.createElement("strong");
  title.textContent = track.name;
  const sub = document.createElement("span");
  sub.textContent = track.status === "error" ? track.error : formatFileSize(track.size);
  nameCell.append(title, sub);

  const bpmCell = document.createElement("td");
  bpmCell.textContent = getBpmLabel(track);

  const durationCell = document.createElement("td");
  durationCell.textContent = track.duration ? formatTime(track.duration) : "--";

  const kicksCell = document.createElement("td");
  kicksCell.textContent = track.analysis ? String(track.analysis.kicks.length) : getStatusLabel(track.status);

  const folderCell = document.createElement("td");
  folderCell.textContent = track.folder || "--";

  const deckCell = document.createElement("td");
  deckCell.className = "deck-loaders";
  const deckA = document.createElement("button");
  deckA.type = "button";
  deckA.className = "btn tiny";
  deckA.textContent = "A";
  deckA.dataset.loadDeck = "A";
  deckA.dataset.trackId = track.id;
  const deckB = document.createElement("button");
  deckB.type = "button";
  deckB.className = "btn tiny";
  deckB.textContent = "B";
  deckB.dataset.loadDeck = "B";
  deckB.dataset.trackId = track.id;
  deckCell.append(deckA, deckB);

  row.append(nameCell, bpmCell, durationCell, kicksCell, folderCell, deckCell);
  return row;
}

function updateDeckControls(deckId) {
  const snapshot = engine.getDeckSnapshot(deckId);
  const refs = elements.deck[deckId];
  const track = snapshot.track;

  refs.root.classList.toggle("is-playing", snapshot.playing);
  const playButton = refs.root.querySelector('[data-action="play"]');
  playButton.classList.toggle("is-active", snapshot.playing);
  playButton.setAttribute("aria-label", snapshot.playing ? `Pausar deck ${deckId}` : `Play deck ${deckId}`);

  refs.title.textContent = track?.name || "Sin cancion cargada";
  refs.artist.textContent = track ? `${track.folder || "Audio local"} / ${track.analysis?.kicks.length || 0} kicks detectados` : "Carga una pista desde la libreria";
  refs.bpm.textContent = getDeckBpmLabel(snapshot);
  refs.time.textContent = `${formatTime(snapshot.position)} / ${formatTime(snapshot.duration)}`;
}

function tick() {
  for (const deckId of ["A", "B"]) {
    const snapshot = engine.getDeckSnapshot(deckId);
    elements.deck[deckId].time.textContent = `${formatTime(snapshot.position)} / ${formatTime(snapshot.duration)}`;
    elements.deck[deckId].bpm.textContent = getDeckBpmLabel(snapshot);
    waveforms[deckId].draw();
  }

  updateMasterMeter(Math.max(engine.getMasterLevel(), getVisualMixLevel()));
  updatePhaseMeter();
  requestAnimationFrame(tick);
}

function getVisualMixLevel() {
  const levels = ["A", "B"].map((deckId) => {
    const snapshot = engine.getDeckSnapshot(deckId);
    if (!snapshot.playing || !snapshot.track?.analysis?.waveform || !snapshot.duration) {
      return 0;
    }

    const waveform = snapshot.track.analysis.waveform;
    const index = Math.max(0, Math.min(waveform.peaks.length - 1, Math.floor((snapshot.position / snapshot.duration) * waveform.peaks.length)));
    return Math.min(1, Math.abs(waveform.peaks[index] - waveform.valleys[index]) * 1.25);
  });

  return Math.min(1, Math.hypot(levels[0], levels[1]) * 0.9);
}

function updateMasterMeter(level) {
  const bars = [...elements.masterMeter.querySelectorAll("i")];
  const active = Math.round(level * bars.length);
  bars.forEach((bar, index) => {
    bar.classList.toggle("is-hot", index < active);
    bar.classList.toggle("is-peak", index > bars.length - 3 && index < active);
  });
}

function updatePhaseMeter() {
  const phaseInfo = engine.getPhaseInfo();
  const lights = [...elements.phaseLights.querySelectorAll("i")];

  if (!phaseInfo) {
    lights.forEach((light) => light.classList.remove("is-on", "is-center"));
    elements.phaseLights.classList.remove("is-zero");
    elements.phaseText.textContent = "Carga dos pistas para comparar";
    return;
  }

  const diff = phaseInfo.diff;
  const phasePercent = Math.abs(diff) < 0.0005 ? 0 : Math.round(diff * 100);
  const center = Math.round((diff + 0.5) * (lights.length - 1));
  lights.forEach((light, index) => {
    light.classList.toggle("is-on", Math.abs(index - center) <= 1);
    light.classList.toggle("is-center", index === center);
  });
  elements.phaseLights.classList.toggle("is-zero", phasePercent === 0);
  elements.phaseText.textContent = `Fase ${phasePercent}%`;
}

function clearAll() {
  engine.stop("A");
  engine.stop("B");
  engine.clearDeck("A");
  engine.clearDeck("B");
  tracks.splice(0, tracks.length);
  renderLibrary();
  resetDeckTempoControl("A");
  resetDeckTempoControl("B");
  updateDeckControls("A");
  updateDeckControls("B");
  showToast("Libreria limpia");
}

function getTrackKey(file, folder) {
  return `${folder}/${file.name}/${file.size}/${file.lastModified}`;
}

function getFolderName(file, source) {
  if (file.webkitRelativePath) {
    const parts = file.webkitRelativePath.split("/");
    parts.pop();
    return parts.join("/") || source;
  }
  return source;
}

function getBpmLabel(track) {
  if (track.status === "decoding") return "Leyendo";
  if (track.status === "analyzing") return "Analizando";
  if (track.status === "error") return "Error";
  return track.analysis?.bpm ? `${track.analysis.bpm}` : "--";
}

function getStatusLabel(status) {
  const labels = {
    ready: "--",
    decoding: "Leyendo",
    analyzing: "Analizando",
    analyzed: "--",
    error: "Error"
  };
  return labels[status] || "--";
}

function getDeckBpmLabel(snapshot) {
  const baseBpm = snapshot.track?.analysis?.bpm;
  if (!baseBpm) return "-- BPM";
  const effective = baseBpm * snapshot.playbackRate;
  return `${effective.toFixed(1)} BPM`;
}

function resetDeckTempoControl(deckId) {
  const input = elements.deck[deckId].root.querySelector('input[data-control="tempo"]');
  input.value = "0";
  elements.deck[deckId].tempo.textContent = "+0.0%";
}

function setTempoInput(deckId, value) {
  const input = elements.deck[deckId].root.querySelector('input[data-control="tempo"]');
  input.value = String(value);
  elements.deck[deckId].tempo.textContent = formatPercent(value);
}

function getSyncMessage(deckId, result) {
  const shift = Math.round(Math.abs(result.phaseShift) * 1000);
  const limit = result.limited ? " al limite del tempo" : "";
  const beat = result.aligned ? ` y kicks alineados (${shift} ms)` : "";
  return `Deck ${deckId} sincronizado${limit}: ${formatPercent(result.tempo)}${beat}`;
}

function cleanTrackName(name) {
  return name.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_-]+/g, " ").trim();
}

function formatPercent(value) {
  const prefix = value >= 0 ? "+" : "";
  return `${prefix}${value.toFixed(1)}%`;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => elements.toast.classList.remove("is-visible"), 2600);
}

function createId() {
  return crypto.randomUUID ? crypto.randomUUID() : `track-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
