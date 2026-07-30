/**
 * Hat-grid interlock (drum-interplay follow-on, 2026-07-30).
 *
 * Two halves, pinned separately:
 *   1. Prompt: the interlock line rides every meter/rate/split variant of
 *      the system prompt (byte identity of 4/4 lives in meter-prompt.test.ts).
 *   2. Pinning: generateArp pins hat/ride siblings PLUS the kick/808/bass
 *      groove anchors as pinTrackDbIds — explicit pins suppress the host's
 *      groove-leader auto-pin, so the anchors must ride along — while its
 *      own voices, MIDI-less tracks, and non-grid roles are never pinned.
 *
 * Harness mirrors arp-generation.test.ts makeHarness, reduced to what the
 * pinning path touches, plus an optional host.listSceneTracks stub.
 */

import type { GenerationServices, GeneratorTrackState } from '@signalsandsorcery/plugin-sdk';
import { SUBMIT_ARP_TOOL_NAME, buildArpSystemPrompt } from '../arp-core';
import { ARP_INTERLOCK_PIN_ROLES, generateArp } from '../arp-generation';

const INTERLOCK_SNIPPET = 'If hat or ride tracks are listed in the context, interlock with their grid';

describe('interlock prompt line', () => {
  it('is present for every rate/split/meter combination', () => {
    const variants = [
      buildArpSystemPrompt({ voiceCount: 1, rate: '1/4', split: 'vertical', bars: 2 }),
      buildArpSystemPrompt({ voiceCount: 2, rate: '1/8', split: 'horizontal', bars: 8 }),
      buildArpSystemPrompt({ voiceCount: 3, rate: '1/16', split: 'vertical', bars: 4, timeSignature: '6/8' }),
      buildArpSystemPrompt({ voiceCount: 2, rate: '1/16', split: 'vertical', bars: 4, timeSignature: '7/8' }),
    ];
    for (const prompt of variants) {
      expect(prompt).toContain(INTERLOCK_SNIPPET);
      expect(prompt).toContain('never drift unrelated to the hat grid');
    }
  });
});

describe('pin-role set', () => {
  it('covers raw drum-folder roles, coarse canonical roles, and the groove anchors', () => {
    for (const role of ['hat-closed', 'hat-open', 'cymbal-ride', 'hats', 'kick', 'kicks', '808', '808s', 'bass']) {
      expect(ARP_INTERLOCK_PIN_ROLES.has(role)).toBe(true);
    }
    // Non-grid roles stay unpinned (ambient context handles them).
    for (const role of ['snare-standard', 'clap', 'pads', 'lead', 'arp', 'tom-low']) {
      expect(ARP_INTERLOCK_PIN_ROLES.has(role)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// generateArp pinning behavior
// ---------------------------------------------------------------------------

type StepsArg = { steps: Array<{ rest?: boolean; tone?: number; octave?: number; velocity?: number }> };

function llmResponse(args: StepsArg): unknown {
  return {
    candidates: [
      { content: { role: 'model', parts: [{ functionCall: { name: SUBMIT_ARP_TOOL_NAME, args } }] } },
    ],
  };
}

const SINGLE_BAND_CELL: StepsArg = {
  steps: [
    { tone: 0, octave: 0, velocity: 100 },
    { rest: true, tone: 0 },
    { tone: 2, octave: 0, velocity: 90 },
    { tone: 1, octave: 0, velocity: 80 },
  ],
};

interface SceneTrackStub {
  dbId: string;
  name: string;
  role?: string;
  hasMidi: boolean;
}

function makeHarness(opts: { sceneTracks?: SceneTrackStub[]; omitListSceneTracks?: boolean } = {}) {
  const host: Record<string, jest.Mock> = {
    getSceneData: jest.fn(async () => null),
    setSceneData: jest.fn(async () => undefined),
    deleteSceneData: jest.fn(async () => undefined),
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
    generateWithLLMTools: jest.fn(async () => llmResponse(SINGLE_BAND_CELL)),
    writeMidiClip: jest.fn(async () => ({})),
    setTrackRole: jest.fn(async () => undefined),
    setTrackMute: jest.fn(async () => undefined),
    shufflePreset: jest.fn(async () => ({ presetName: 'P', presetCategory: 'Synths-hi' })),
    deleteTrack: jest.fn(async () => undefined),
    showToast: jest.fn(),
  };
  if (!opts.omitListSceneTracks) {
    host.listSceneTracks = jest.fn(async () => opts.sceneTracks ?? []);
  }

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
      id: `eng-new${suffix}`, name: `arp${suffix}`, dbId: `db-new${suffix}`,
    })),
    resolvedGroups: jest.fn(() => []),
  } as unknown as GenerationServices;

  const track = {
    handle: { id: 'eng-a', name: 'arp-1', dbId: 'db-a' },
    prompt: '1 voice, plucky arp',
    role: '',
    runtimeState: { muted: false, solo: false },
  } as unknown as GeneratorTrackState;

  return { services, track, host };
}

describe('generateArp sibling pinning', () => {
  it('pins hat/ride + groove anchors by dbId; skips MIDI-less, own-anchor, and non-grid roles', async () => {
    const h = makeHarness({
      sceneTracks: [
        { dbId: 'db-hat', name: 'Hats', role: 'hat-closed', hasMidi: true },
        { dbId: 'db-ride', name: 'Ride', role: 'cymbal-ride', hasMidi: true },
        { dbId: 'db-kick', name: 'Kick', role: 'kick', hasMidi: true },
        { dbId: 'db-bass', name: 'Bass', role: 'bass', hasMidi: true },
        { dbId: 'db-empty-hat', name: 'Empty hat', role: 'hat-open', hasMidi: false },
        { dbId: 'db-snare', name: 'Snare', role: 'snare-standard', hasMidi: true },
        { dbId: 'db-a', name: 'arp-1', role: 'arp', hasMidi: true },
      ],
    });
    await generateArp(h.track, h.services);

    expect(h.host.getGenerationContext).toHaveBeenCalledWith('eng-a', {
      pinTrackDbIds: ['db-hat', 'db-ride', 'db-kick', 'db-bass'],
    });
  });

  it('falls back to the single-arg call (host auto-pin path) when nothing matches', async () => {
    const h = makeHarness({
      sceneTracks: [{ dbId: 'db-lead', name: 'Lead', role: 'lead', hasMidi: true }],
    });
    await generateArp(h.track, h.services);

    expect(h.host.getGenerationContext).toHaveBeenCalledWith('eng-a');
  });

  it('tolerates hosts without listSceneTracks (optional SDK 2.42.0 surface)', async () => {
    const h = makeHarness({ omitListSceneTracks: true });
    await generateArp(h.track, h.services);

    expect(h.host.getGenerationContext).toHaveBeenCalledWith('eng-a');
  });
});
