/**
 * 🔗 Apply All (linkSounds) — the arp side of the linked-sound feature:
 * the config validator carries the flag, per-voice removal preserves it
 * (count shrink AND anchor handoff), and generation honors it — linked
 * groups share ONE sound (anchor's durable identity, first generation
 * shuffles the anchor once then copies), with a clean fallback to the
 * legacy per-voice shuffle when the services have no sound adapter.
 */

import type {
  GenerationServices,
  GeneratorTrackState,
  TrackSoundSnapshot,
} from '@signalsandsorcery/plugin-sdk';
import { SUBMIT_ARP_TOOL_NAME } from '../arp-core';
import { generateArp } from '../arp-generation';
import {
  ARP_CONFIG_KEY,
  ARP_VOICE_META_KEY,
  asArpConfig,
  type ArpVoiceMeta,
} from '../arp-voice-meta';
import { prepareVoiceRemoval } from '../remove-voice';

// ---------------------------------------------------------------------------
// Validator carry
// ---------------------------------------------------------------------------

describe('asArpConfig linkSounds carry', () => {
  const base = { voiceCount: 2, rate: '1/16', split: 'vertical' };

  it('carries linkSounds: true and false', () => {
    expect(asArpConfig({ ...base, linkSounds: true })?.linkSounds).toBe(true);
    expect(asArpConfig({ ...base, linkSounds: false })?.linkSounds).toBe(false);
  });

  it('drops non-boolean linkSounds and leaves absent absent', () => {
    const nonBool = asArpConfig({ ...base, linkSounds: 'yes' });
    expect(nonBool).not.toBeNull();
    expect(nonBool && 'linkSounds' in nonBool).toBe(false);
    const absent = asArpConfig(base);
    expect(absent).not.toBeNull();
    expect(absent && 'linkSounds' in absent).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-voice removal preserves the toggle
// ---------------------------------------------------------------------------

describe('prepareVoiceRemoval linkSounds carry', () => {
  const keyFor = (dbId: string, suffix: string): string => `track:${dbId}:${suffix}`;
  const meta = (groupId: string, voiceIndex: number): ArpVoiceMeta => ({
    groupId,
    voiceIndex,
    label: `v${voiceIndex}`,
  });

  function makeHost(seed: Record<string, unknown>): {
    host: { getSceneData: jest.Mock; setSceneData: jest.Mock };
    data: Map<string, unknown>;
  } {
    const data = new Map<string, unknown>(Object.entries(seed));
    return {
      host: {
        getSceneData: jest.fn(async (_s: string, key: string) => data.get(key) ?? null),
        setSceneData: jest.fn(async (_s: string, key: string, value: unknown) => {
          data.set(key, value);
        }),
      },
      data,
    };
  }

  it('keeps linkSounds through a non-anchor count shrink', async () => {
    const { host, data } = makeHost({
      'track:db-a:arpConfig': { voiceCount: 3, rate: '1/16', split: 'vertical', linkSounds: true },
    });
    await prepareVoiceRemoval({
      host,
      sceneId: 'scene-1',
      keyFor,
      members: [
        { dbId: 'db-a', meta: meta('db-a', 0) },
        { dbId: 'db-b', meta: meta('db-a', 1) },
        { dbId: 'db-c', meta: meta('db-a', 2) },
      ],
      deletedDbId: 'db-c',
    });
    expect(data.get('track:db-a:arpConfig')).toMatchObject({ voiceCount: 2, linkSounds: true });
  });

  it('keeps linkSounds through an anchor handoff', async () => {
    const { host, data } = makeHost({
      'track:db-a:arpConfig': { voiceCount: 3, rate: '1/16', split: 'vertical', linkSounds: true },
      'track:db-a:prompt': 'glassy trance arp',
    });
    await prepareVoiceRemoval({
      host,
      sceneId: 'scene-1',
      keyFor,
      members: [
        { dbId: 'db-a', meta: meta('db-a', 0) },
        { dbId: 'db-b', meta: meta('db-a', 1) },
        { dbId: 'db-c', meta: meta('db-a', 2) },
      ],
      deletedDbId: 'db-a',
    });
    // Config moved to the NEW anchor's key, flag intact.
    expect(data.get('track:db-b:arpConfig')).toMatchObject({ voiceCount: 2, linkSounds: true });
  });
});

// ---------------------------------------------------------------------------
// Generation honors the toggle
// ---------------------------------------------------------------------------

type StepsArg = { steps: Array<{ rest?: boolean; tone?: number; octave?: number; velocity?: number }> };

function llmResponse(args: StepsArg): unknown {
  return {
    candidates: [
      { content: { role: 'model', parts: [{ functionCall: { name: SUBMIT_ARP_TOOL_NAME, args } }] } },
    ],
  };
}

/** Two pitch bands so the vertical split fills exactly 2 voices. */
const TWO_BAND_CELL: StepsArg = {
  steps: [
    { tone: 0, octave: 0, velocity: 100 },
    { tone: 2, octave: 1, velocity: 90 },
    { rest: true, tone: 0 },
    { tone: 2, octave: 1, velocity: 90 },
  ],
};

const SNAP: TrackSoundSnapshot = {
  kind: 'preset',
  state: 'BASE64-SHARED',
  label: 'Glass Keys',
  stateType: 'valuetree',
} as TrackSoundSnapshot;

interface Harness {
  services: GenerationServices;
  track: GeneratorTrackState;
  calls: string[];
  sceneData: Map<string, unknown>;
  host: Record<string, jest.Mock>;
  copySnapshot: jest.Mock;
}

function makeHarness(opts: {
  storedConfig?: Record<string, unknown>;
  anchorSnap?: TrackSoundSnapshot | null;
  /** When true, shuffling the anchor makes getTrackSound start returning SNAP. */
  shuffleMintsAnchorPreset?: boolean;
  withSoundAdapter?: boolean;
} = {}): Harness {
  const calls: string[] = [];
  const sceneData = new Map<string, unknown>();
  if (opts.storedConfig) sceneData.set(`track:db-a:${ARP_CONFIG_KEY}`, opts.storedConfig);
  let anchorSnap: TrackSoundSnapshot | null = opts.anchorSnap ?? null;

  const host: Record<string, jest.Mock> = {
    getSceneData: jest.fn(async (_scene: string, key: string) => sceneData.get(key) ?? null),
    setSceneData: jest.fn(async (_scene: string, key: string, value: unknown) => {
      calls.push(`setSceneData:${key}`);
      sceneData.set(key, value);
    }),
    deleteSceneData: jest.fn(async () => {}),
    getMusicalContext: jest.fn(async () => ({
      key: 'A', mode: 'minor', bpm: 120, bars: 1, genre: 'trance',
      timeSignature: '4/4',
      chordProgression: [{ symbol: 'Am', startQn: 0, endQn: 4 }],
      contractPrompt: null,
    })),
    getGenerationContext: jest.fn(async () => ({
      chordProgression: { key: { tonic: 'A', mode: 'minor' }, chordsWithTiming: [], genre: null },
      concurrentTracks: [],
    })),
    generateWithLLMTools: jest.fn(async () => llmResponse(TWO_BAND_CELL)),
    writeMidiClip: jest.fn(async (engineId: string) => { calls.push(`writeMidiClip:${engineId}`); return {}; }),
    setTrackRole: jest.fn(async () => {}),
    setTrackMute: jest.fn(async () => {}),
    shufflePreset: jest.fn(async (engineId: string) => {
      calls.push(`shufflePreset:${engineId}`);
      if (opts.shuffleMintsAnchorPreset && engineId === 'eng-a') anchorSnap = SNAP;
      return { presetName: `P-${engineId}`, presetCategory: 'Synths-hi' };
    }),
    getTrackSound: jest.fn(async (dbId: string) => (dbId === 'db-a' ? anchorSnap : null)),
    deleteTrack: jest.fn(async () => {}),
    showToast: jest.fn(),
  };

  const copySnapshot = jest.fn(async (engineId: string) => {
    calls.push(`copySnapshot:${engineId}`);
    return 'Glass Keys';
  });

  const services = {
    host: host as never,
    activeSceneId: 'scene-1',
    tracks: [{ id: 0 }],
    updateTrack: jest.fn(),
    setTracks: jest.fn(),
    reloadTracks: jest.fn(async () => {}),
    soundHistory: {} as never,
    engineToDbId: (id: string) => id,
    trackDataKey: (dbId: string, suffix: string) => `track:${dbId}:${suffix}`,
    markEditLoaded: jest.fn(),
    createFamilyTrack: jest.fn(async (suffix = '') => ({
      id: `eng-new${suffix}`,
      name: `arp${suffix}`,
      dbId: `db-new${suffix}`,
    })),
    resolvedGroups: jest.fn(() => []),
    ...(opts.withSoundAdapter === false ? {} : { sound: { copySnapshot } }),
  } as unknown as GenerationServices;

  const track = {
    handle: { id: 'eng-a', name: 'arp-1', dbId: 'db-a' },
    prompt: '2 voices, glassy trance arp',
    role: '',
    runtimeState: { muted: false, solo: false },
  } as unknown as GeneratorTrackState;

  return { services, track, calls, sceneData, host, copySnapshot };
}

const LINKED_CONFIG = { voiceCount: 2, rate: '1/16', split: 'vertical', linkSounds: true };

describe('generateArp with linkSounds', () => {
  it('linked regeneration: zero shuffles, anchor snapshot copied to every NEW voice, flag carried', async () => {
    const h = makeHarness({ storedConfig: LINKED_CONFIG, anchorSnap: SNAP });
    await generateArp(h.track, h.services);

    expect(h.host.shufflePreset).not.toHaveBeenCalled();
    // Anchor reused; the 1 new voice copies the shared sound.
    expect(h.calls.filter((c) => c.startsWith('copySnapshot'))).toEqual(['copySnapshot:eng-new-v1']);
    expect(h.copySnapshot).toHaveBeenCalledWith('eng-new-v1', SNAP);
    // The config rewrite must not wipe the toggle.
    expect(h.sceneData.get(`track:db-a:${ARP_CONFIG_KEY}`)).toMatchObject({ linkSounds: true });
    expect(h.sceneData.get(`track:db-a:${ARP_VOICE_META_KEY}`)).toMatchObject({ groupId: 'db-a' });
  });

  it('linked FIRST generation: shuffles the anchor exactly once, then copies to the rest', async () => {
    const h = makeHarness({
      storedConfig: LINKED_CONFIG,
      anchorSnap: null,
      shuffleMintsAnchorPreset: true,
    });
    await generateArp(h.track, h.services);

    expect(h.calls.filter((c) => c.startsWith('shufflePreset'))).toEqual(['shufflePreset:eng-a']);
    expect(h.calls.filter((c) => c.startsWith('copySnapshot'))).toEqual(['copySnapshot:eng-new-v1']);
  });

  it('linked but no services.sound adapter: falls back to the legacy per-voice shuffle', async () => {
    const h = makeHarness({ storedConfig: LINKED_CONFIG, anchorSnap: SNAP, withSoundAdapter: false });
    await generateArp(h.track, h.services);

    expect(h.calls.filter((c) => c.startsWith('copySnapshot'))).toHaveLength(0);
    expect(h.calls.filter((c) => c.startsWith('shufflePreset'))).toEqual(['shufflePreset:eng-new-v1']);
  });

  it('unlinked config keeps the historical per-voice shuffle path untouched', async () => {
    const h = makeHarness({
      storedConfig: { voiceCount: 2, rate: '1/16', split: 'vertical' },
      anchorSnap: SNAP,
    });
    await generateArp(h.track, h.services);

    expect(h.calls.filter((c) => c.startsWith('copySnapshot'))).toHaveLength(0);
    expect(h.calls.filter((c) => c.startsWith('shufflePreset'))).toEqual(['shufflePreset:eng-new-v1']);
    const written = h.sceneData.get(`track:db-a:${ARP_CONFIG_KEY}`) as Record<string, unknown>;
    expect('linkSounds' in written).toBe(false);
  });
});
