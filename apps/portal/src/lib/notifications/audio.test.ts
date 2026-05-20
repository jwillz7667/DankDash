import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createChimePlayer, type ChimeAudioContext } from './audio.js';

interface ScheduledNote {
  readonly pitch: number;
  readonly startedAt: number;
  readonly stoppedAt: number;
}

function makeFakeContext(initialState: AudioContextState = 'suspended'): ChimeAudioContext & {
  readonly scheduled: readonly ScheduledNote[];
  state: AudioContextState;
  currentTime: number;
  resumeCalls: number;
  closeCalls: number;
} {
  const scheduled: ScheduledNote[] = [];
  let state: AudioContextState = initialState;
  let currentTime = 0;
  const destination = { kind: 'destination' } as unknown as AudioNode;

  function makeNode(): { connect: (next: unknown) => unknown } {
    return {
      connect: (next: unknown): unknown => next,
    };
  }

  function createOscillator(): OscillatorNode {
    let pitch = 0;
    let startedAt = 0;
    let stoppedAt = 0;
    const node = {
      ...makeNode(),
      type: 'sine',
      frequency: {
        setValueAtTime: (value: number, _t: number): void => {
          pitch = value;
        },
      },
      start: (t: number): void => {
        startedAt = t;
      },
      stop: (t: number): void => {
        stoppedAt = t;
        scheduled.push({ pitch, startedAt, stoppedAt });
      },
    };
    return node as unknown as OscillatorNode;
  }

  function createGain(): GainNode {
    const node = {
      ...makeNode(),
      gain: {
        setValueAtTime: (_v: number, _t: number): void => undefined,
        linearRampToValueAtTime: (_v: number, _t: number): void => undefined,
        exponentialRampToValueAtTime: (_v: number, _t: number): void => undefined,
      },
    };
    return node as unknown as GainNode;
  }

  return {
    scheduled,
    get state(): AudioContextState {
      return state;
    },
    set state(next: AudioContextState) {
      state = next;
    },
    get currentTime(): number {
      return currentTime;
    },
    set currentTime(next: number) {
      currentTime = next;
    },
    destination,
    resumeCalls: 0,
    closeCalls: 0,
    createOscillator,
    createGain,
    async resume(): Promise<void> {
      // Increment first via Reflect to satisfy strict get-set semantics
      // in the test's typed object — the prototype counter lives on the
      // object we return.
      (this as unknown as { resumeCalls: number }).resumeCalls += 1;
      state = 'running';
    },
    async close(): Promise<void> {
      (this as unknown as { closeCalls: number }).closeCalls += 1;
      state = 'closed';
    },
  };
}

describe('createChimePlayer', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a player that is a no-op when no AudioContext is available', async () => {
    const player = createChimePlayer({ audioContextFactory: (): null => null });
    await expect(player.play()).resolves.toBeUndefined();
    await expect(player.prime()).resolves.toBeUndefined();
    await expect(player.dispose()).resolves.toBeUndefined();
  });

  it('schedules two notes per play() at the configured pitches', async () => {
    const ctx = makeFakeContext('running');
    const player = createChimePlayer({
      audioContextFactory: (): ChimeAudioContext => ctx,
      frequency: 600,
      secondFrequency: 900,
      duration: 0.2,
    });
    await player.play();

    expect(ctx.scheduled).toHaveLength(2);
    expect(ctx.scheduled[0]?.pitch).toBe(600);
    expect(ctx.scheduled[1]?.pitch).toBe(900);
    // Second note begins after the first note ends + the inter-note gap.
    expect(ctx.scheduled[1]?.startedAt).toBeGreaterThan(ctx.scheduled[0]?.stoppedAt ?? 0);
  });

  it('resumes a suspended context on prime() before play() makes sound', async () => {
    const ctx = makeFakeContext('suspended');
    const player = createChimePlayer({ audioContextFactory: (): ChimeAudioContext => ctx });

    await player.prime();
    expect(ctx.resumeCalls).toBe(1);
    expect(ctx.state).toBe('running');

    await player.play();
    expect(ctx.scheduled).toHaveLength(2);
  });

  it('resumes implicitly inside play() when the context is still suspended', async () => {
    const ctx = makeFakeContext('suspended');
    const player = createChimePlayer({ audioContextFactory: (): ChimeAudioContext => ctx });

    await player.play();
    expect(ctx.resumeCalls).toBe(1);
    expect(ctx.scheduled).toHaveLength(2);
  });

  it('skips scheduling when resume() fails (autoplay policy still blocking)', async () => {
    const ctx = makeFakeContext('suspended');
    ctx.resume = async (): Promise<void> => {
      throw new Error('NotAllowedError');
    };
    const player = createChimePlayer({ audioContextFactory: (): ChimeAudioContext => ctx });

    await player.play();
    expect(ctx.scheduled).toHaveLength(0);
  });

  it('skips scheduling when resume() succeeds but state remains suspended', async () => {
    const ctx = makeFakeContext('suspended');
    ctx.resume = async (): Promise<void> => {
      // The spec allows resume() to resolve without transitioning state
      // — we treat that as "still gated" and decline to schedule.
      return;
    };
    const player = createChimePlayer({ audioContextFactory: (): ChimeAudioContext => ctx });

    await player.play();
    expect(ctx.scheduled).toHaveLength(0);
  });

  it('only constructs the context once across many play() calls', async () => {
    const ctx = makeFakeContext('running');
    const factory = vi.fn((): ChimeAudioContext => ctx);
    const player = createChimePlayer({ audioContextFactory: factory });

    await player.play();
    await player.play();
    await player.play();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(ctx.scheduled).toHaveLength(6);
  });

  it('survives an audioContextFactory that throws (degrades to silent)', async () => {
    const player = createChimePlayer({
      audioContextFactory: (): ChimeAudioContext => {
        throw new Error('not supported');
      },
    });
    await expect(player.play()).resolves.toBeUndefined();
  });

  it('dispose() closes the context and gates further plays', async () => {
    const ctx = makeFakeContext('running');
    const player = createChimePlayer({ audioContextFactory: (): ChimeAudioContext => ctx });
    await player.play();
    expect(ctx.scheduled).toHaveLength(2);

    await player.dispose();
    expect(ctx.closeCalls).toBe(1);

    await player.play();
    // No new scheduling after dispose.
    expect(ctx.scheduled).toHaveLength(2);
  });

  it('dispose() swallows a close() rejection (already-closed contexts)', async () => {
    const ctx = makeFakeContext('running');
    ctx.close = async (): Promise<void> => {
      throw new Error('InvalidStateError');
    };
    const player = createChimePlayer({ audioContextFactory: (): ChimeAudioContext => ctx });
    await expect(player.dispose()).resolves.toBeUndefined();
  });
});
