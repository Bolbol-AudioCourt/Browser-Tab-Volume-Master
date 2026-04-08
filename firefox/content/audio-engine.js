(() => {
  const extensionApi = globalThis.browser ?? globalThis.chrome;

  if (!extensionApi?.runtime?.onMessage) {
    return;
  }

  const DEFAULT_BANDS = [
    { id: 1, type: 'lowshelf', freq: 80, gain: 0, q: 0.8, minFreq: 20, maxFreq: 250 },
    { id: 2, type: 'peaking', freq: 250, gain: 0, q: 1.1, minFreq: 80, maxFreq: 1200 },
    { id: 3, type: 'peaking', freq: 1200, gain: 0, q: 1.0, minFreq: 400, maxFreq: 5000 },
    { id: 4, type: 'highshelf', freq: 5000, gain: 0, q: 0.8, minFreq: 2000, maxFreq: 20000 }
  ];

  const VOLUME_RANGE = { min: 0, max: 400 };
  const GAIN_RANGE = { min: -12, max: 12 };

  let settings = createDefaultSettings();
  let audioContext = null;
  let inputNode = null;
  let outputNode = null;
  let filterNodes = [];
  const sourceNodes = new WeakMap();
  const trackedElements = new WeakSet();
  const managedElements = new WeakSet();

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function createDefaultSettings() {
    return {
      volumePercent: 100,
      bands: DEFAULT_BANDS.map(cloneBand)
    };
  }

  function cloneBand(band) {
    return {
      id: band.id,
      type: band.type,
      freq: band.freq,
      gain: band.gain,
      q: band.q,
      minFreq: band.minFreq,
      maxFreq: band.maxFreq
    };
  }

  function normalizeSettings(candidate = {}) {
    const nextBands = DEFAULT_BANDS.map((defaultBand, index) => {
      const incoming = candidate.bands?.[index] ?? settings.bands[index] ?? defaultBand;
      return {
        id: defaultBand.id,
        type: defaultBand.type,
        q: defaultBand.q,
        minFreq: defaultBand.minFreq,
        maxFreq: defaultBand.maxFreq,
        freq: clamp(Number(incoming.freq ?? defaultBand.freq), defaultBand.minFreq, defaultBand.maxFreq),
        gain: clamp(Number(incoming.gain ?? defaultBand.gain), GAIN_RANGE.min, GAIN_RANGE.max)
      };
    });

    return {
      volumePercent: clamp(Number(candidate.volumePercent ?? settings.volumePercent ?? 100), VOLUME_RANGE.min, VOLUME_RANGE.max),
      bands: nextBands
    };
  }

  function getState() {
    return {
      volumePercent: settings.volumePercent,
      bands: settings.bands.map(cloneBand),
      mediaCount: document.querySelectorAll('audio, video').length,
      supported: true
    };
  }

  function ensureAudioGraph() {
    if (audioContext) {
      return;
    }

    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass) {
      return;
    }

    audioContext = new AudioContextClass();
    inputNode = audioContext.createGain();
    outputNode = audioContext.createGain();
    filterNodes = settings.bands.map((band) => {
      const filter = audioContext.createBiquadFilter();
      filter.type = band.type;
      filter.frequency.value = band.freq;
      filter.gain.value = band.gain;
      filter.Q.value = band.q;
      return filter;
    });

    let previousNode = inputNode;
    for (const filterNode of filterNodes) {
      previousNode.connect(filterNode);
      previousNode = filterNode;
    }

    previousNode.connect(outputNode);
    outputNode.connect(audioContext.destination);
    applyCurrentSettings();
  }

  function applyCurrentSettings() {
    if (!audioContext || !outputNode) {
      return;
    }

    const ratio = settings.volumePercent / 100;
    outputNode.gain.value = ratio > 1 ? ratio : 1;

    document.querySelectorAll('audio, video').forEach((mediaElement) => {
      if (!(mediaElement instanceof HTMLMediaElement)) {
        return;
      }

      managedElements.add(mediaElement);
      mediaElement.volume = clamp(ratio, 0, 1);
    });

    filterNodes.forEach((filterNode, index) => {
      const band = settings.bands[index];
      filterNode.type = band.type;
      filterNode.frequency.value = band.freq;
      filterNode.gain.value = band.gain;
      filterNode.Q.value = band.q;
    });
  }

  function resumeContext() {
    if (audioContext?.state === 'suspended') {
      audioContext.resume().catch(() => {});
    }
  }

  function attachMediaElement(mediaElement) {
    if (!(mediaElement instanceof HTMLMediaElement) || trackedElements.has(mediaElement)) {
      return;
    }

    trackedElements.add(mediaElement);
    ensureAudioGraph();

    if (!audioContext || !inputNode) {
      return;
    }

    try {
      const existingSource = sourceNodes.get(mediaElement);
      const sourceNode = existingSource ?? audioContext.createMediaElementSource(mediaElement);
      if (!existingSource) {
        sourceNodes.set(mediaElement, sourceNode);
        sourceNode.connect(inputNode);
      }

      mediaElement.volume = clamp(settings.volumePercent / 100, 0, 1);
      mediaElement.addEventListener('play', resumeContext, { passive: true });
      mediaElement.addEventListener('volumechange', resumeContext, { passive: true });
    } catch (error) {
      console.warn('[Volume Master] Failed to attach media element.', error);
    }
  }

  function scanForMedia(root = document) {
    const elements = root.querySelectorAll ? root.querySelectorAll('audio, video') : [];
    elements.forEach(attachMediaElement);
  }

  function updateSettings(partialSettings = {}) {
    settings = normalizeSettings({
      volumePercent: partialSettings.volumePercent ?? settings.volumePercent,
      bands: partialSettings.bands ?? settings.bands
    });

    scanForMedia();
    applyCurrentSettings();
    resumeContext();
    return getState();
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof Element)) {
          return;
        }

        if (node.matches?.('audio, video')) {
          attachMediaElement(node);
        }
        scanForMedia(node);
      });
    }
  });

  if (document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  document.addEventListener(
    'play',
    (event) => {
      const target = event.target;
      if (target instanceof HTMLMediaElement) {
        attachMediaElement(target);
        resumeContext();
      }
    },
    true
  );

  scanForMedia();

  extensionApi.runtime.onMessage.addListener((message) => {
    switch (message?.type) {
      case 'VOLUME_MASTER_GET_STATE':
        return Promise.resolve(getState());
      case 'VOLUME_MASTER_UPDATE_SETTINGS':
        return Promise.resolve(updateSettings(message.settings));
      default:
        return false;
    }
  });
})();
