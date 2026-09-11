/**
 * Minimal DSP helpers for the audio analysis stage: Hann window, an iterative
 * radix-2 FFT, and Welch power spectral density estimation. No external
 * dependencies — ported from the Welch implementation in the cassette
 * restoration pipeline (mejora_audio.py), which used numpy directly.
 */

/** Generate a periodic Hann window of the given size. */
export function hannWindow(size: number): Float64Array {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    // Periodic form: matches numpy.hanning (which is the symmetric Hann minus
    // the last point, i.e. periodic over size samples).
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  }
  return w;
}

/**
 * In-place iterative radix-2 Cooley-Tukey FFT. `re` and `im` must have equal
 * power-of-two lengths. Results are unnormalized.
 */
export function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n === 0 || (n & (n - 1)) !== 0) {
    throw new Error(`FFT length must be a power of two, got ${n}`);
  }
  if (im.length !== n) {
    throw new Error("FFT real and imaginary buffers must have equal length");
  }

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j |= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }

  // Butterflies.
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angle = (-2 * Math.PI) / len;
    const stepRe = Math.cos(angle);
    const stepIm = Math.sin(angle);
    for (let base = 0; base < n; base += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < half; k++) {
        const i0 = base + k;
        const i1 = i0 + half;
        const uRe = re[i0]!;
        const uIm = im[i0]!;
        const vRe = re[i1]! * curRe - im[i1]! * curIm;
        const vIm = re[i1]! * curIm + im[i1]! * curRe;
        re[i0] = uRe + vRe;
        im[i0] = uIm + vIm;
        re[i1] = uRe - vRe;
        im[i1] = uIm - vIm;
        const nextRe = curRe * stepRe - curIm * stepIm;
        curIm = curRe * stepIm + curIm * stepRe;
        curRe = nextRe;
      }
    }
  }
}

export interface WelchResult {
  /** Frequency of each PSD bin (length windowSize/2 + 1) */
  freqs: Float64Array;
  /** Mean power spectral density, one value per bin */
  psd: Float64Array;
}

/**
 * Welch PSD estimate: Hann window, 50% overlap, mean of frame power spectra.
 * Mirrors mejora_audio.py welch_psd(): signals shorter than one window are
 * analyzed as a single zero-padded frame.
 */
export function welchPsd(
  samples: ArrayLike<number>,
  sampleRate: number,
  windowSize = 8192,
): WelchResult {
  if (windowSize < 2 || (windowSize & (windowSize - 1)) !== 0) {
    throw new Error(`windowSize must be a power of two, got ${windowSize}`);
  }

  const n = samples.length;
  const half = windowSize >> 1;
  const binCount = half + 1;
  const acc = new Float64Array(binCount);
  const window = hannWindow(windowSize);
  const re = new Float64Array(windowSize);
  const im = new Float64Array(windowSize);

  const accumulate = (start: number, count: number): void => {
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < count; i++) {
      re[i] = samples[start + i]! * window[i]!;
    }
    fftInPlace(re, im);
    for (let i = 0; i < binCount; i++) {
      acc[i] += re[i]! * re[i]! + im[i]! * im[i]!;
    }
  };

  let frames = 0;
  const hop = half;
  if (n <= windowSize) {
    // Zero-padded single frame.
    accumulate(0, n);
    frames = 1;
  } else {
    for (let start = 0; start + windowSize <= n; start += hop) {
      accumulate(start, windowSize);
      frames++;
    }
  }

  const freqs = new Float64Array(binCount);
  const psd = new Float64Array(binCount);
  for (let i = 0; i < binCount; i++) {
    freqs[i] = (i * sampleRate) / windowSize;
    psd[i] = acc[i]! / frames;
  }

  return { freqs, psd };
}
