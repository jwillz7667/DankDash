/**
 * Web Audio API chime for new-order alerts.
 *
 * Why oscillator-synthesized rather than a sample file:
 *
 *   1. Zero asset dependency — works even if the static-asset CDN is
 *      degraded. The chime exists exactly when the JS bundle has
 *      finished loading; nothing else has to land.
 *   2. Deterministic — the same waveform on every browser; no MP3 vs.
 *      OGG vs. AAC codec negotiation, no decode latency.
 *   3. The "two-note attention chime" pattern is recognizable to anyone
 *      who has worked retail or food-service. Engineering a custom
 *      sample isn't worth the bundle bytes.
 *
 * Autoplay policy:
 *
 *   Chrome and Safari block `AudioContext` from making sound until the
 *   first user gesture on the page. We split that gate from `play()`
 *   so the caller can `prime()` from a click handler (e.g. the mute
 *   toggle's first interaction) and subsequent realtime `play()` calls
 *   work without a gesture every time. Browsers that don't enforce the
 *   policy still see the same code path, just with a no-op resume.
 *
 * Pure module — no React, no DOM hook into the lifecycle. The React
 * hook layer above this owns the singleton player and disposes it on
 * unmount.
 */

/**
 * Subset of the Web Audio API surface we touch. Wider than the actual
 * `AudioContext` so tests can pass a minimal fake without implementing
 * dozens of unused methods. Production code uses the real DOM type via
 * the default factory.
 */
export interface ChimeAudioContext {
  readonly state: AudioContextState;
  readonly currentTime: number;
  readonly destination: AudioNode;
  createOscillator(): OscillatorNode;
  createGain(): GainNode;
  resume(): Promise<void>;
  close(): Promise<void>;
}

export interface ChimePlayer {
  /**
   * Trigger the chime. Resolves once the underlying scheduling is in
   * place — the sound itself plays asynchronously off the audio thread.
   * No-op if the AudioContext can't be unlocked or is unavailable.
   */
  play(): Promise<void>;
  /**
   * Unblock the audio context from a user gesture. Call from a click
   * handler before relying on `play()` to make audible sound. Idempotent
   * — repeat calls after the context is already running are no-ops.
   */
  prime(): Promise<void>;
  /**
   * Tear down the context. The player rejects further play()/prime()
   * calls after dispose; the consumer should drop the reference.
   */
  dispose(): Promise<void>;
}

export interface ChimePlayerOptions {
  /**
   * Carrier frequency for the first tone in Hz. Defaults to 880 (A5)
   * — a single semitone above standard concert A, recognisable as a
   * "ping" without being shrill.
   */
  readonly frequency?: number;
  /**
   * Second-tone frequency, played 80ms after the first. Defaults to
   * 1320 (E6) — a perfect fifth above the carrier. The fifth is the
   * most consonant non-unison interval; it reads as "two beats" rather
   * than "noise".
   */
  readonly secondFrequency?: number;
  /**
   * Per-tone duration in seconds. Defaults to 0.25. Above ~0.6s the
   * chime starts to feel like an alarm; below ~0.12s it's perceptually
   * a click.
   */
  readonly duration?: number;
  /**
   * Peak gain (0..1). Defaults to 0.2 — loud enough to hear over a
   * busy dispensary, low enough not to spike headphones.
   */
  readonly volume?: number;
  /**
   * Test seam. Production omits this and the default DOM factory builds
   * a real `AudioContext`; tests pass a fake that records oscillator
   * scheduling without making sound.
   */
  readonly audioContextFactory?: () => ChimeAudioContext | null;
}

const DEFAULTS = {
  frequency: 880,
  secondFrequency: 1320,
  duration: 0.25,
  volume: 0.2,
  noteGap: 0.08,
};

export function createChimePlayer(opts: ChimePlayerOptions = {}): ChimePlayer {
  const factory = opts.audioContextFactory ?? defaultAudioContextFactory;
  const frequency = opts.frequency ?? DEFAULTS.frequency;
  const secondFrequency = opts.secondFrequency ?? DEFAULTS.secondFrequency;
  const duration = opts.duration ?? DEFAULTS.duration;
  const volume = opts.volume ?? DEFAULTS.volume;

  let ctx: ChimeAudioContext | null = null;
  let disposed = false;

  function ensureContext(): ChimeAudioContext | null {
    if (disposed) return null;
    if (ctx !== null) return ctx;
    try {
      ctx = factory();
      return ctx;
    } catch (error) {
      // Browser without Web Audio support, or factory threw on
      // construction (some Safari builds throw if too many contexts
      // are open). Chime degrades to silent; browser notifications
      // still fire on their own channel.
      void error;
      ctx = null;
      return null;
    }
  }

  async function unlock(context: ChimeAudioContext): Promise<boolean> {
    if (isRunning(context)) return true;
    try {
      await context.resume();
    } catch (error) {
      // Resume failures happen when play() is called outside a user
      // gesture before any prime(). The next operator interaction
      // (mute toggle, "enable alerts" button) will unlock it.
      void error;
      return false;
    }
    return isRunning(context);
  }

  function scheduleNote(context: ChimeAudioContext, pitch: number, startOffset: number): void {
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = 'sine';
    const startAt = context.currentTime + startOffset;
    osc.frequency.setValueAtTime(pitch, startAt);

    // ADSR envelope avoids the click that an abrupt on/off transition
    // produces. Quick attack (10ms), short hold, exponential release
    // — perceptually a clean "beep" rather than a square-wave buzz.
    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(volume, startAt + 0.01);
    gain.gain.setValueAtTime(volume, startAt + duration * 0.5);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

    osc.connect(gain).connect(context.destination);
    osc.start(startAt);
    osc.stop(startAt + duration);
  }

  async function play(): Promise<void> {
    const context = ensureContext();
    if (context === null) return;
    const unlocked = await unlock(context);
    if (!unlocked) return;
    scheduleNote(context, frequency, 0);
    scheduleNote(context, secondFrequency, duration + DEFAULTS.noteGap);
  }

  async function prime(): Promise<void> {
    const context = ensureContext();
    if (context === null) return;
    await unlock(context);
  }

  async function dispose(): Promise<void> {
    disposed = true;
    const context = ctx;
    ctx = null;
    if (context === null) return;
    try {
      await context.close();
    } catch (error) {
      // close() rejects if the context is already closed — benign.
      void error;
    }
  }

  return { play, prime, dispose };
}

/**
 * Read `state` through a function call so TypeScript's narrowing from
 * the early-return check above doesn't pin the type to "everything
 * except 'running'" — the await between the two checks can change
 * the underlying state and the compiler has no way to model that.
 */
function isRunning(context: ChimeAudioContext): boolean {
  return context.state === 'running';
}

type AudioContextConstructor = new () => ChimeAudioContext;

interface WindowWithLegacyAudio {
  readonly AudioContext?: AudioContextConstructor;
  readonly webkitAudioContext?: AudioContextConstructor;
}

function defaultAudioContextFactory(): ChimeAudioContext | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as WindowWithLegacyAudio;
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (Ctor === undefined) return null;
  return new Ctor();
}
