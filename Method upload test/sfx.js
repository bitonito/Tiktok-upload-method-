/**
 * SFX Engine — Web Audio API synthesized sounds
 * No external files required.
 */

const SFX = (() => {
  let ctx = null;

  function getCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    return ctx;
  }

  function playTone({ freq = 440, type = 'sine', duration = 0.2, gain = 0.3, detune = 0, delay = 0, ramp = true }) {
    const ac = getCtx();
    const osc = ac.createOscillator();
    const gainNode = ac.createGain();
    const filter = ac.createBiquadFilter();

    osc.type = type;
    osc.frequency.value = freq;
    osc.detune.value = detune;
    filter.type = 'lowpass';
    filter.frequency.value = 4000;

    osc.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(ac.destination);

    const t = ac.currentTime + delay;
    gainNode.gain.setValueAtTime(0, t);
    gainNode.gain.linearRampToValueAtTime(gain, t + 0.02);
    if (ramp) gainNode.gain.exponentialRampToValueAtTime(0.001, t + duration);

    osc.start(t);
    osc.stop(t + duration + 0.05);
  }

  function playNoise({ duration = 0.15, gain = 0.15, filterFreq = 800, delay = 0 }) {
    const ac = getCtx();
    const bufferSize = ac.sampleRate * (duration + 0.1);
    const buffer = ac.createBuffer(1, bufferSize, ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

    const source = ac.createBufferSource();
    source.buffer = buffer;

    const filter = ac.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = filterFreq;
    filter.Q.value = 0.5;

    const gainNode = ac.createGain();
    gainNode.gain.setValueAtTime(0, ac.currentTime + delay);
    gainNode.gain.linearRampToValueAtTime(gain, ac.currentTime + delay + 0.01);
    gainNode.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + delay + duration);

    source.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(ac.destination);
    source.start(ac.currentTime + delay);
  }

  return {
    /** Played when file is dropped/selected */
    fileSelect() {
      // Rising twin tones — "accepted"
      playTone({ freq: 440, type: 'sine', duration: 0.15, gain: 0.18, delay: 0 });
      playTone({ freq: 660, type: 'sine', duration: 0.15, gain: 0.15, delay: 0.1 });
    },

    /** Played when processing starts */
    processStart() {
      // Deep power-up sweep
      const ac = getCtx();
      const osc = ac.createOscillator();
      const gainNode = ac.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(80, ac.currentTime);
      osc.frequency.exponentialRampToValueAtTime(440, ac.currentTime + 0.4);
      gainNode.gain.setValueAtTime(0, ac.currentTime);
      gainNode.gain.linearRampToValueAtTime(0.1, ac.currentTime + 0.05);
      gainNode.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.5);
      osc.connect(gainNode);
      gainNode.connect(ac.destination);
      osc.start(ac.currentTime);
      osc.stop(ac.currentTime + 0.55);

      // High shine
      playTone({ freq: 880, type: 'triangle', duration: 0.25, gain: 0.08, delay: 0.2 });
    },

    /** Played during processing — tick every ~second */
    tick() {
      playTone({ freq: 220, type: 'square', duration: 0.06, gain: 0.04, detune: 0 });
    },

    /** Played on completion */
    success() {
      // Triumphant chord arpeggio
      const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6
      notes.forEach((freq, i) => {
        playTone({ freq, type: 'triangle', duration: 0.4, gain: 0.15, delay: i * 0.08 });
      });
      // Woosh
      playNoise({ duration: 0.3, gain: 0.06, filterFreq: 2000, delay: 0.1 });
    },

    /** Played on error */
    error() {
      playTone({ freq: 200, type: 'sawtooth', duration: 0.2, gain: 0.15, delay: 0 });
      playTone({ freq: 150, type: 'sawtooth', duration: 0.3, gain: 0.15, delay: 0.15 });
      playNoise({ duration: 0.2, gain: 0.08, filterFreq: 400, delay: 0 });
    },

    /** Played on drag-over */
    dragHover() {
      playTone({ freq: 330, type: 'sine', duration: 0.08, gain: 0.06, delay: 0 });
    },

    /** Click */
    click() {
      playTone({ freq: 800, type: 'sine', duration: 0.05, gain: 0.08, delay: 0 });
    },

    /** Download */
    download() {
      playTone({ freq: 660, type: 'triangle', duration: 0.12, gain: 0.14, delay: 0 });
      playTone({ freq: 880, type: 'triangle', duration: 0.12, gain: 0.10, delay: 0.1 });
    }
  };
})();
