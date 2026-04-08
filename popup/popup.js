(() => {
  const extensionApi = globalThis.browser ?? globalThis.chrome;

  const DEFAULT_BANDS = [
    { id: 1, type: 'lowshelf', freq: 80, gain: 0, q: 0.8, minFreq: 20, maxFreq: 250 },
    { id: 2, type: 'peaking', freq: 250, gain: 0, q: 1.1, minFreq: 80, maxFreq: 1200 },
    { id: 3, type: 'peaking', freq: 1200, gain: 0, q: 1.0, minFreq: 400, maxFreq: 5000 },
    { id: 4, type: 'highshelf', freq: 5000, gain: 0, q: 0.8, minFreq: 2000, maxFreq: 20000 }
  ];

  const VOLUME_RANGE = { min: 0, max: 400 };
  const GAIN_RANGE = { min: -12, max: 12 };
  const FREQ_RANGE = { min: 20, max: 20000 };
  const TRACK_ANGLE = { min: -135, max: 135 };
  const CANVAS_PADDING = { top: 16, right: 16, bottom: 28, left: 16 };

  const knob = document.getElementById('volumeKnob');
  const volumeValue = document.getElementById('volumeValue');
  const eqToggle = document.getElementById('eqToggle');
  const eqPanel = document.getElementById('eqPanel');
  const eqCanvas = document.getElementById('eqCanvas');
  const canvasContext = eqCanvas.getContext('2d');

  let activeTabId = null;
  let knobDrag = null;
  let activeBandIndex = null;
  let latestUpdateToken = 0;
  let analysisContext = null;
  let state = createDefaultState();

  function createDefaultState() {
    return {
      volumePercent: 100,
      bands: DEFAULT_BANDS.map((band) => ({ ...band }))
    };
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function round(value, digits = 0) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }

  function log2(value) {
    return Math.log(value) / Math.log(2);
  }

  function normalizeState(candidate) {
    return {
      volumePercent: clamp(Number(candidate?.volumePercent ?? 100), VOLUME_RANGE.min, VOLUME_RANGE.max),
      bands: DEFAULT_BANDS.map((defaultBand, index) => {
        const incoming = candidate?.bands?.[index] ?? defaultBand;
        return {
          ...defaultBand,
          freq: clamp(Number(incoming.freq ?? defaultBand.freq), defaultBand.minFreq, defaultBand.maxFreq),
          gain: clamp(Number(incoming.gain ?? defaultBand.gain), GAIN_RANGE.min, GAIN_RANGE.max)
        };
      })
    };
  }

  function volumeToAngle(volumePercent) {
    const progress = volumePercent / VOLUME_RANGE.max;
    return TRACK_ANGLE.min + progress * (TRACK_ANGLE.max - TRACK_ANGLE.min);
  }

  function ensureAnalysisContext() {
    if (analysisContext) {
      return analysisContext;
    }

    const OfflineContext = globalThis.OfflineAudioContext ?? globalThis.webkitOfflineAudioContext;
    if (typeof OfflineContext === 'function') {
      analysisContext = new OfflineContext(1, 2, 44100);
    }

    return analysisContext;
  }

  async function sendMessage(message) {
    if (!activeTabId) {
      return null;
    }

    try {
      return await extensionApi.tabs.sendMessage(activeTabId, message);
    } catch {
      return null;
    }
  }

  async function syncState() {
    const response = await sendMessage({ type: 'VOLUME_MASTER_GET_STATE' });
    if (response) {
      state = normalizeState(response);
    }
    render();
  }

  async function pushState(partialState) {
    const updateToken = ++latestUpdateToken;
    state = normalizeState({ ...state, ...partialState });
    render();

    const response = await sendMessage({
      type: 'VOLUME_MASTER_UPDATE_SETTINGS',
      settings: partialState
    });

    if (response && updateToken === latestUpdateToken) {
      state = normalizeState(response);
      render();
    }
  }

  function render() {
    volumeValue.textContent = `${Math.round(state.volumePercent)}%`;
    knob.style.setProperty('--knob-rotation', `${volumeToAngle(state.volumePercent)}deg`);
    knob.setAttribute('aria-valuenow', String(Math.round(state.volumePercent)));
    drawEq();
  }

  function getPlotBounds() {
    return {
      left: CANVAS_PADDING.left,
      right: eqCanvas.width - CANVAS_PADDING.right,
      top: CANVAS_PADDING.top,
      bottom: eqCanvas.height - CANVAS_PADDING.bottom,
      width: eqCanvas.width - CANVAS_PADDING.left - CANVAS_PADDING.right,
      height: eqCanvas.height - CANVAS_PADDING.top - CANVAS_PADDING.bottom
    };
  }

  function freqToX(freq) {
    const bounds = getPlotBounds();
    const ratio = (log2(freq) - log2(FREQ_RANGE.min)) / (log2(FREQ_RANGE.max) - log2(FREQ_RANGE.min));
    return bounds.left + ratio * bounds.width;
  }

  function xToFreq(x) {
    const bounds = getPlotBounds();
    const ratio = clamp((x - bounds.left) / bounds.width, 0, 1);
    return 2 ** (log2(FREQ_RANGE.min) + ratio * (log2(FREQ_RANGE.max) - log2(FREQ_RANGE.min)));
  }

  function gainToY(gain) {
    const bounds = getPlotBounds();
    const ratio = (GAIN_RANGE.max - gain) / (GAIN_RANGE.max - GAIN_RANGE.min);
    return bounds.top + ratio * bounds.height;
  }

  function yToGain(y) {
    const bounds = getPlotBounds();
    const ratio = clamp((y - bounds.top) / bounds.height, 0, 1);
    return GAIN_RANGE.max - ratio * (GAIN_RANGE.max - GAIN_RANGE.min);
  }

  function computeResponse() {
    const audioContext = ensureAnalysisContext();
    const bounds = getPlotBounds();
    const frequencies = new Float32Array(bounds.width);

    for (let index = 0; index < bounds.width; index += 1) {
      frequencies[index] = xToFreq(bounds.left + index);
    }

    const magnitudes = new Float32Array(bounds.width).fill(1);

    if (audioContext) {
      state.bands.forEach((band) => {
        const filter = audioContext.createBiquadFilter();
        filter.type = band.type;
        filter.frequency.value = band.freq;
        filter.gain.value = band.gain;
        filter.Q.value = band.q;

        const bandMagnitude = new Float32Array(bounds.width);
        const bandPhase = new Float32Array(bounds.width);
        filter.getFrequencyResponse(frequencies, bandMagnitude, bandPhase);

        for (let index = 0; index < bounds.width; index += 1) {
          magnitudes[index] *= bandMagnitude[index];
        }
      });
    }

    return Array.from(magnitudes, (magnitude, index) => ({
      x: bounds.left + index,
      gain: clamp(20 * Math.log10(Math.max(magnitude, 1e-4)), GAIN_RANGE.min, GAIN_RANGE.max)
    }));
  }

  function drawEq() {
    if (!canvasContext) {
      return;
    }

    const bounds = getPlotBounds();
    canvasContext.clearRect(0, 0, eqCanvas.width, eqCanvas.height);
    canvasContext.fillStyle = '#3c3c3c';
    canvasContext.fillRect(0, 0, eqCanvas.width, eqCanvas.height);

    drawGrid(bounds);
    drawCurve(computeResponse());
    drawBandHandles();
  }

  function drawGrid(bounds) {
    const freqLabels = [20, 100, 1000, 10000];
    const gainLines = [-12, -6, 0, 6, 12];

    canvasContext.strokeStyle = 'rgba(255,255,255,0.06)';
    canvasContext.lineWidth = 1;

    gainLines.forEach((gain) => {
      const y = gainToY(gain);
      canvasContext.beginPath();
      canvasContext.moveTo(bounds.left, y);
      canvasContext.lineTo(bounds.right, y);
      canvasContext.stroke();

      canvasContext.fillStyle = gain === 0 ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.3)';
      canvasContext.font = '11px -apple-system, sans-serif';
      canvasContext.fillText(String(gain), 4, y + 4);
    });

    freqLabels.forEach((freq) => {
      const x = freqToX(freq);
      canvasContext.beginPath();
      canvasContext.moveTo(x, bounds.top);
      canvasContext.lineTo(x, bounds.bottom);
      canvasContext.stroke();

      canvasContext.fillStyle = 'rgba(255,255,255,0.3)';
      canvasContext.font = '11px -apple-system, sans-serif';
      canvasContext.fillText(freq >= 1000 ? `${freq / 1000}k` : `${freq}`, x - 10, eqCanvas.height - 8);
    });
  }

  function drawCurve(points) {
    canvasContext.beginPath();
    points.forEach((point, index) => {
      const y = gainToY(point.gain);
      if (index === 0) {
        canvasContext.moveTo(point.x, y);
      } else {
        canvasContext.lineTo(point.x, y);
      }
    });

    canvasContext.strokeStyle = '#1dd3f8';
    canvasContext.lineWidth = 2;
    canvasContext.stroke();
  }

  function drawBandHandles() {
    state.bands.forEach((band, index) => {
      const x = freqToX(band.freq);
      const y = gainToY(band.gain);

      canvasContext.beginPath();
      canvasContext.arc(x, y, 8, 0, Math.PI * 2);
      canvasContext.fillStyle = index === activeBandIndex ? '#ffca62' : '#f5a623';
      canvasContext.fill();
      canvasContext.lineWidth = 2;
      canvasContext.strokeStyle = '#2a2a2a';
      canvasContext.stroke();

      canvasContext.fillStyle = '#2a2a2a';
      canvasContext.font = 'bold 10px -apple-system, sans-serif';
      canvasContext.textAlign = 'center';
      canvasContext.textBaseline = 'middle';
      canvasContext.fillText(String(band.id), x, y + 0.5);
    });

    canvasContext.textAlign = 'left';
    canvasContext.textBaseline = 'alphabetic';
  }

  function getCanvasPoint(clientX, clientY) {
    const rect = eqCanvas.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * eqCanvas.width,
      y: ((clientY - rect.top) / rect.height) * eqCanvas.height
    };
  }

  function findBandUnderPointer(clientX, clientY) {
    const point = getCanvasPoint(clientX, clientY);

    return state.bands.findIndex((band) => {
      const handleX = freqToX(band.freq);
      const handleY = gainToY(band.gain);
      return Math.hypot(handleX - point.x, handleY - point.y) <= 14;
    });
  }

  function updateBandFromPointer(index, clientX, clientY) {
    const point = getCanvasPoint(clientX, clientY);
    const band = state.bands[index];

    const nextBands = state.bands.map((entry, bandIndex) => (
      bandIndex === index
        ? {
            ...entry,
            freq: clamp(xToFreq(point.x), band.minFreq, band.maxFreq),
            gain: round(clamp(yToGain(point.y), GAIN_RANGE.min, GAIN_RANGE.max), 1)
          }
        : entry
    ));

    pushState({ bands: nextBands });
  }

  knob.addEventListener('pointerdown', (event) => {
    knobDrag = { pointerId: event.pointerId, startY: event.clientY, startValue: state.volumePercent };
    knob.setPointerCapture(event.pointerId);
  });

  knob.addEventListener('pointermove', (event) => {
    if (!knobDrag || event.pointerId !== knobDrag.pointerId) {
      return;
    }

    const delta = (knobDrag.startY - event.clientY) * 2;
    const nextValue = clamp(Math.round(knobDrag.startValue + delta), VOLUME_RANGE.min, VOLUME_RANGE.max);
    pushState({ volumePercent: nextValue });
  });

  knob.addEventListener('pointerup', (event) => {
    if (knobDrag?.pointerId === event.pointerId) {
      knob.releasePointerCapture(event.pointerId);
      knobDrag = null;
    }
  });

  knob.addEventListener('pointercancel', () => {
    knobDrag = null;
  });

  knob.addEventListener('wheel', (event) => {
    event.preventDefault();
    const step = event.deltaY < 0 ? 5 : -5;
    pushState({ volumePercent: clamp(state.volumePercent + step, VOLUME_RANGE.min, VOLUME_RANGE.max) });
  });

  knob.addEventListener('dblclick', () => {
    pushState({ volumePercent: 100 });
  });

  knob.addEventListener('keydown', (event) => {
    const stepMap = {
      ArrowUp: 5,
      ArrowRight: 5,
      ArrowDown: -5,
      ArrowLeft: -5,
      PageUp: 25,
      PageDown: -25
    };

    if (event.key === 'Home') {
      event.preventDefault();
      pushState({ volumePercent: 0 });
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      pushState({ volumePercent: 400 });
      return;
    }

    if (stepMap[event.key]) {
      event.preventDefault();
      pushState({ volumePercent: clamp(state.volumePercent + stepMap[event.key], VOLUME_RANGE.min, VOLUME_RANGE.max) });
    }
  });

  eqToggle.addEventListener('click', () => {
    const expanded = eqToggle.getAttribute('aria-expanded') === 'true';
    eqToggle.setAttribute('aria-expanded', String(!expanded));
    eqPanel.hidden = expanded;
    if (!expanded) {
      drawEq();
    }
  });

  eqCanvas.addEventListener('pointerdown', (event) => {
    const bandIndex = findBandUnderPointer(event.clientX, event.clientY);
    if (bandIndex === -1) {
      return;
    }

    activeBandIndex = bandIndex;
    eqCanvas.setPointerCapture(event.pointerId);
    updateBandFromPointer(bandIndex, event.clientX, event.clientY);
    drawEq();
  });

  eqCanvas.addEventListener('pointermove', (event) => {
    if (activeBandIndex === null) {
      return;
    }

    updateBandFromPointer(activeBandIndex, event.clientX, event.clientY);
  });

  eqCanvas.addEventListener('pointerup', (event) => {
    if (activeBandIndex !== null) {
      eqCanvas.releasePointerCapture(event.pointerId);
      activeBandIndex = null;
      drawEq();
    }
  });

  eqCanvas.addEventListener('pointercancel', () => {
    activeBandIndex = null;
    drawEq();
  });

  window.addEventListener('load', drawEq);
  window.addEventListener('resize', drawEq);

  async function init() {
    const [tab] = await extensionApi.tabs.query({ active: true, currentWindow: true });
    activeTabId = tab?.id ?? null;
    render();
    await syncState();
  }

  init().catch((error) => {
    console.error('[Volume Master] Failed to initialize popup.', error);
    render();
  });
})();
