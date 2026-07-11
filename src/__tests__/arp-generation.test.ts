/**
 * The brain, end to end against a stubbed host: schema-forced request shape,
 * config precedence (stored > hints > defaults), the create→clip→role→preset→
 * meta ordering, vertical + horizontal splits, the plain retry, budget
 * refusal, surplus removal, and LIFO rollback.
 */

import type {
  GenerationServices,
  GeneratorTrackState,
  LLMToolUseRequest,
} from '@signalsandsorcery/plugin-sdk';
import { SUBMIT_ARP_TOOL_NAME } from '../arp-core';
import { generateArp, ARP_MAX_TRACKS } from '../arp-generation';
import { ARP_CONFIG_KEY, ARP_VOICE_META_KEY } from '../arp-voice-meta';

type StepsArg = { steps: Array<{ rest?: boolean; tone?: number; octave?: number; velocity?: number }> };

function llmResponse(args: StepsArg): unknown {
  return {
    candidates: [
      { content: { role: 'model', parts: [{ functionCall: { name: SUBMIT_ARP_TOOL_NAME, args } }] } },
    ],
  };
}

/**
 * A two-band cell: roots in the home octave, fifths an octave up — expands
 * to exactly two pitch classes so the default vertical split fills 2 voices.
 */
const TWO_BAND_CELL: StepsArg = {
  steps: [
    { tone: 0, octave: 0, velocity: 100 },
    { tone: 2, octave: 1, velocity: 90 },
    { rest: true, tone: 0 },
    { tone: 2, octave: 1, velocity: 90 },
  ],
};

interface HarnessGroupMember {
  dbId: string;
  engineId: string;
  voiceIndex: number;
  prompt?: string;
}

interface Harness {
  services: GenerationServices;
  track: GeneratorTrackState;
  calls: string[];
  llmRequests: LLMToolUseRequest[];
  sceneData: Map<string, unknown>;
  host: Record<string, jest.Mock>;
}

function makeHarness(opts: {
  llmResults?: unknown[];
  trackCount?: number;
  failClipWrite?: boolean;
  bars?: number;
  prompt?: string;
  storedConfig?: { voiceCount: number; rate: string; split: string };
  groupMembers?: HarnessGroupMember[];
} = {}): Harness {
  const calls: string[] = [];
  const llmRequests: LLMToolUseRequest[] = [];
  const sceneData = new Map<string, unknown>();
  const llmResults = [...(opts.llmResults ?? [llmResponse(TWO_BAND_CELL)])];
  if (opts.storedConfig) {
    sceneData.set(`track:db-a:${ARP_CONFIG_KEY}`, opts.storedConfig);
  }

  const host: Record<string, jest.Mock> = {
    getSceneData: jest.fn(async (_scene: string, key: string) => sceneData.get(key) ?? null),
    setSceneData: jest.fn(async (_scene: string, key: string, value: unknown) => {
      calls.push(`setSceneData:${key}`);
      sceneData.set(key, value);
    }),
    deleteSceneData: jest.fn(async (_scene: string, key: string) => { calls.push(`deleteSceneData:${key}`); }),
    getMusicalContext: jest.fn(async () => ({
      key: 'A', mode: 'minor', bpm: 120, bars: opts.bars ?? 1, genre: 'trance',
      timeSignature: '4/4',
      chordProgression: (opts.bars ?? 1) >= 2
        ? [{ symbol: 'Am', startQn: 0, endQn: 4 }, { symbol: 'F', startQn: 4, endQn: 8 }]
        : [{ symbol: 'Am', startQn: 0, endQn: 4 }],
      contractPrompt: 'late-night trance',
    })),
    getGenerationContext: jest.fn(async () => ({
      chordProgression: { key: { tonic: 'A', mode: 'minor' }, chordsWithTiming: [], genre: null },
      concurrentTracks: [{
        trackId: 'eng-drums', dbId: 'db-drums', name: 'Drums', role: 'kicks',
        presetCategory: null,
        notesByChord: [{ chord: 'Am', chordRangeQn: [0, 4] as [number, number], notes: [
          { pitch: 60, startBeat: 0, durationBeats: 0.25, velocity: 120 },
        ] }],
      }],
    })),
    generateWithLLMTools: jest.fn(async (request: LLMToolUseRequest) => {
      llmRequests.push(request);
      const next = llmResults.length > 1 ? llmResults.shift() : llmResults[0];
      return next;
    }),
    writeMidiClip: jest.fn(async (engineId: string) => {
      if (opts.failClipWrite) throw new Error('engine says no');
      calls.push(`writeMidiClip:${engineId}`);
      return {};
    }),
    setTrackRole: jest.fn(async (engineId: string, role: string) => { calls.push(`setTrackRole:${engineId}:${role}`); }),
    setTrackMute: jest.fn(async () => { calls.push('mute'); }),
    shufflePreset: jest.fn(async (engineId: string) => {
      calls.push(`shufflePreset:${engineId}`);
      return { presetName: `P-${engineId}`, presetCategory: 'Synths-hi' };
    }),
    deleteTrack: jest.fn(async (engineId: string) => { calls.push(`deleteTrack:${engineId}`); }),
    showToast: jest.fn(),
  };

  const group = (opts.groupMembers ?? []).map((m) => ({
    dbId: m.dbId,
    track: {
      handle: { id: m.engineId, name: `arp-${m.voiceIndex}`, dbId: m.dbId },
      prompt: m.prompt ?? '',
      runtimeState: { muted: false, solo: false },
    },
    meta: { groupId: 'db-a', voiceIndex: m.voiceIndex, label: '' },
  }));

  const services = {
    host: host as never,
    activeSceneId: 'scene-1',
    tracks: Array.from({ length: opts.trackCount ?? 1 }, (_, i) => ({ id: i })),
    updateTrack: jest.fn(),
    setTracks: jest.fn(),
    reloadTracks: jest.fn(async () => {}),
    soundHistory: {} as never,
    engineToDbId: (id: string) => id,
    trackDataKey: (dbId: string, suffix: string) => `track:${dbId}:${suffix}`,
    markEditLoaded: jest.fn(),
    createFamilyTrack: jest.fn(async (suffix = '') => {
      calls.push(`createFamilyTrack:${suffix}`);
      return { id: `eng-new${suffix}`, name: `arp${suffix}`, dbId: `db-new${suffix}` };
    }),
    resolvedGroups: jest.fn(() => (group.length > 0 ? [{ groupId: 'db-a', members: group }] : [])),
  } as unknown as GenerationServices;

  const track = {
    handle: { id: 'eng-a', name: 'arp-1', dbId: 'db-a' },
    prompt: opts.prompt ?? '2 voices, glassy trance arp',
    role: '',
    runtimeState: { muted: false, solo: false },
  } as unknown as GeneratorTrackState;

  return { services, track, calls, llmRequests, sceneData, host };
}

describe('generateArp', () => {
  it('makes ONE schema-forced call and executes create→clip→role→preset→meta in order', async () => {
    const h = makeHarness();
    await generateArp(h.track, h.services);

    // Request shape: forced function calling with our tool + assembled context.
    expect(h.llmRequests).toHaveLength(1);
    const req = h.llmRequests[0];
    expect(req.toolConfig?.functionCallingConfig?.mode).toBe('ANY');
    expect(req.toolConfig?.functionCallingConfig?.allowedFunctionNames).toEqual([SUBMIT_ARP_TOOL_NAME]);
    const sys = req.systemInstruction?.parts?.[0]?.text ?? '';
    expect(sys).toContain('repeating arp cell');
    expect(sys).toContain('1/16-note grid');
    const user = (req.contents[0].parts[0] as { text: string }).text;
    expect(user).toContain('Musical Context:');
    expect(user).toContain('Am (beats 0-4)');
    expect(user).toContain('Concurrent tracks in scene');
    expect(user).toContain('User request: "2 voices, glassy trance arp"');

    // 2 voices (hint-driven), anchor reused → 1 new track created.
    expect(h.calls.filter(c => c.startsWith('createFamilyTrack'))).toHaveLength(1);
    expect(h.calls.filter(c => c.startsWith('writeMidiClip'))).toHaveLength(2);

    // Ordering: every clip write precedes every preset shuffle; metas come last.
    const firstShuffle = h.calls.findIndex(c => c.startsWith('shufflePreset'));
    const lastClip = h.calls.map((c, i) => (c.startsWith('writeMidiClip') ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    expect(lastClip).toBeLessThan(firstShuffle);
    const firstMeta = h.calls.findIndex(c => c.startsWith(`setSceneData:track:db-a:${ARP_VOICE_META_KEY}`));
    expect(firstMeta).toBeGreaterThan(firstShuffle);

    // Presets only for NEW voices (anchor reused keeps its patch).
    expect(h.calls.filter(c => c.startsWith('shufflePreset'))).toEqual(['shufflePreset:eng-new-v1']);

    // Every voice carries the canonical arp role.
    expect(h.calls).toContain('setTrackRole:eng-a:arp');
    expect(h.calls).toContain('setTrackRole:eng-new-v1:arp');

    // Anchor meta has groupId = anchor dbId + the mechanical band label;
    // config persisted with resolved values.
    expect(h.sceneData.get(`track:db-a:${ARP_VOICE_META_KEY}`)).toMatchObject({
      groupId: 'db-a',
      voiceIndex: 0,
      label: 'top band',
    });
    expect(h.sceneData.get(`track:db-a:${ARP_CONFIG_KEY}`)).toEqual({
      voiceCount: 2,
      rate: '1/16',
      split: 'vertical',
    });
  });

  it('stored header config beats prompt hints', async () => {
    const h = makeHarness({
      prompt: '4 voices 1/16 vertical wild arp',
      storedConfig: { voiceCount: 1, rate: '1/4', split: 'horizontal' },
    });
    await generateArp(h.track, h.services);
    // Single voice → no new tracks; the system prompt reflects the stored 1/4 grid.
    expect(h.calls.filter(c => c.startsWith('createFamilyTrack'))).toHaveLength(0);
    const sys = h.llmRequests[0].systemInstruction?.parts?.[0]?.text ?? '';
    expect(sys).toContain('1/4-note grid (4 steps per 4/4 bar)');
  });

  it('splits horizontally by alternating bars when configured', async () => {
    const h = makeHarness({
      bars: 2,
      storedConfig: { voiceCount: 2, rate: '1/16', split: 'horizontal' },
    });
    await generateArp(h.track, h.services);
    expect(h.calls.filter(c => c.startsWith('createFamilyTrack'))).toHaveLength(1);
    expect(h.sceneData.get(`track:db-a:${ARP_VOICE_META_KEY}`)).toMatchObject({ label: 'odd bars' });
    expect(h.sceneData.get(`track:db-new-v1:${ARP_VOICE_META_KEY}`)).toMatchObject({ label: 'even bars' });
  });

  it('retries ONCE on an unusable reply, then succeeds', async () => {
    const h = makeHarness({ llmResults: [{ candidates: [] }, llmResponse(TWO_BAND_CELL)] });
    await generateArp(h.track, h.services);
    expect(h.llmRequests).toHaveLength(2);
    expect((h.llmRequests[1].contents[0].parts[0] as { text: string }).text).toContain('unusable');
    expect(h.calls.filter(c => c.startsWith('writeMidiClip'))).toHaveLength(2);
  });

  it('throws when both attempts come back unusable', async () => {
    const h = makeHarness({ llmResults: [{ candidates: [] }] });
    await expect(generateArp(h.track, h.services)).rejects.toThrow(/no usable arp cell/);
    expect(h.calls.filter(c => c.startsWith('createFamilyTrack'))).toHaveLength(0);
  });

  it('refuses when the reconcile would exceed the panel track budget', async () => {
    const h = makeHarness({ trackCount: ARP_MAX_TRACKS });
    await expect(generateArp(h.track, h.services)).rejects.toThrow(/panel budget/);
    expect(h.calls.filter(c => c.startsWith('createFamilyTrack'))).toHaveLength(0);
  });

  it('removes surplus voices (track + group keys) when the group shrinks', async () => {
    const h = makeHarness({
      trackCount: 3,
      storedConfig: { voiceCount: 1, rate: '1/16', split: 'vertical' },
      groupMembers: [
        { dbId: 'db-a', engineId: 'eng-a', voiceIndex: 0, prompt: 'shimmer arp' },
        { dbId: 'db-b', engineId: 'eng-b', voiceIndex: 1 },
        { dbId: 'db-c', engineId: 'eng-c', voiceIndex: 2 },
      ],
    });
    await generateArp(h.track, h.services);
    expect(h.calls).toContain('deleteTrack:eng-b');
    expect(h.calls).toContain('deleteTrack:eng-c');
    expect(h.calls).toContain(`deleteSceneData:track:db-b:${ARP_VOICE_META_KEY}`);
    expect(h.calls).toContain('deleteSceneData:track:db-c:soundHistory');
    expect(h.calls.filter(c => c.startsWith('createFamilyTrack'))).toHaveLength(0);
  });

  it('rolls back created tracks LIFO when a clip write fails', async () => {
    const h = makeHarness({ failClipWrite: true });
    await expect(generateArp(h.track, h.services)).rejects.toThrow('engine says no');
    // The one created voice is deleted again and its meta key scrubbed.
    expect(h.calls).toContain('deleteTrack:eng-new-v1');
    expect(h.calls).toContain(`deleteSceneData:track:db-new-v1:${ARP_VOICE_META_KEY}`);
  });
});
