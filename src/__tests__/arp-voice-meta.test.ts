/**
 * Voice-group metadata: validation, the positional reconcile planner, and
 * the deterministic prompt hints.
 */

import {
  asArpConfig,
  asArpVoiceMeta,
  arpGroupIsComplete,
  normalizeRate,
  normalizeSplit,
  parsePromptHints,
  planReconcile,
} from '../arp-voice-meta';
import type { ResolvedTrackGroup, GeneratorTrackState } from '@signalsandsorcery/plugin-sdk';
import type { ArpVoiceMeta } from '../arp-voice-meta';

describe('asArpVoiceMeta', () => {
  it('accepts a valid meta and defaults the label', () => {
    expect(asArpVoiceMeta({ groupId: 'g', voiceIndex: 1, label: 'top band' })).toEqual({
      groupId: 'g',
      voiceIndex: 1,
      label: 'top band',
    });
    expect(asArpVoiceMeta({ groupId: 'g', voiceIndex: 0 })).toEqual({
      groupId: 'g',
      voiceIndex: 0,
      label: '',
    });
  });

  it('rejects structurally-wrong values', () => {
    expect(asArpVoiceMeta(null)).toBeNull();
    expect(asArpVoiceMeta('x')).toBeNull();
    expect(asArpVoiceMeta({ groupId: 'g' })).toBeNull();
    expect(asArpVoiceMeta({ voiceIndex: 0 })).toBeNull();
  });
});

describe('asArpConfig', () => {
  it('round-trips a valid config and rejects partials', () => {
    expect(asArpConfig({ voiceCount: 2, rate: '1/16', split: 'vertical' })).toEqual({
      voiceCount: 2,
      rate: '1/16',
      split: 'vertical',
    });
    expect(asArpConfig({ voiceCount: 2 })).toBeNull();
    expect(asArpConfig(null)).toBeNull();
  });
});

describe('normalizeRate / normalizeSplit', () => {
  it('clamps stored strings back into the closed domains', () => {
    expect(normalizeRate('1/8', '1/16')).toBe('1/8');
    expect(normalizeRate('1/32', '1/16')).toBe('1/16');
    expect(normalizeRate(undefined, '1/4')).toBe('1/4');
    expect(normalizeSplit('horizontal', 'vertical')).toBe('horizontal');
    expect(normalizeSplit('diagonal', 'vertical')).toBe('vertical');
  });
});

describe('arpGroupIsComplete', () => {
  const group = (indexes: number[]): ResolvedTrackGroup<ArpVoiceMeta, GeneratorTrackState> =>
    ({
      groupId: 'g',
      members: indexes.map((voiceIndex) => ({
        dbId: `db-${voiceIndex}`,
        track: {} as GeneratorTrackState,
        meta: { groupId: 'g', voiceIndex, label: '' },
      })),
    }) as unknown as ResolvedTrackGroup<ArpVoiceMeta, GeneratorTrackState>;

  it('requires the anchor (voiceIndex 0)', () => {
    expect(arpGroupIsComplete(group([0, 1]))).toBe(true);
    expect(arpGroupIsComplete(group([1, 2]))).toBe(false);
  });
});

describe('planReconcile', () => {
  const members = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ dbId: `db-${i}`, engineId: `eng-${i}`, voiceIndex: i }));

  it('grows: reuses existing members positionally and creates the rest', () => {
    const plan = planReconcile(members(2), 3);
    expect(plan.reuse).toEqual([
      { dbId: 'db-0', engineId: 'eng-0', bucketIndex: 0 },
      { dbId: 'db-1', engineId: 'eng-1', bucketIndex: 1 },
    ]);
    expect(plan.createBucketIndexes).toEqual([2]);
    expect(plan.remove).toEqual([]);
  });

  it('shrinks: keeps the anchor, removes the surplus tail', () => {
    const plan = planReconcile(members(3), 1);
    expect(plan.reuse).toEqual([{ dbId: 'db-0', engineId: 'eng-0', bucketIndex: 0 }]);
    expect(plan.createBucketIndexes).toEqual([]);
    expect(plan.remove).toEqual([
      { dbId: 'db-1', engineId: 'eng-1' },
      { dbId: 'db-2', engineId: 'eng-2' },
    ]);
  });

  it('sorts by voiceIndex so the anchor always lands in bucket 0', () => {
    const shuffled = [members(3)[2], members(3)[0], members(3)[1]];
    const plan = planReconcile(shuffled, 3);
    expect(plan.reuse[0]).toEqual({ dbId: 'db-0', engineId: 'eng-0', bucketIndex: 0 });
  });
});

describe('parsePromptHints', () => {
  it('extracts voice count, rate, and split from natural phrasing', () => {
    expect(parsePromptHints('3 voice glassy arp')).toEqual({ voiceCount: 3 });
    expect(parsePromptHints('two patches, 1/16 skippy')).toEqual({ rate: '1/16' });
    expect(parsePromptHints('sixteenth note rave arp')).toEqual({ rate: '1/16' });
    expect(parsePromptHints('lazy eighth arp')).toEqual({ rate: '1/8' });
    expect(parsePromptHints('quarter pulse')).toEqual({ rate: '1/4' });
    expect(parsePromptHints('2 voices alternating bars')).toEqual({
      voiceCount: 2,
      split: 'horizontal',
    });
    expect(parsePromptHints('vertical split across 4 parts')).toEqual({
      voiceCount: 4,
      split: 'vertical',
    });
    expect(parsePromptHints('dreamy pluck cascade')).toEqual({});
  });
});
