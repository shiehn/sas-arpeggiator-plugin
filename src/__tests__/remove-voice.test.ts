/**
 * Per-voice removal: the pure plan and the scene-data surgery (config
 * shrink, anchor handoff, last-voice / miss no-ops).
 */

import { planVoiceRemoval, prepareVoiceRemoval, type VoiceRemovalMember } from '../remove-voice';
import { ARP_CONFIG_KEY, ARP_VOICE_META_KEY, type ArpVoiceMeta } from '../arp-voice-meta';

const keyFor = (dbId: string, suffix: string): string => `track:${dbId}:${suffix}`;

function member(dbId: string, voiceIndex: number, groupId = 'a', label = `v${voiceIndex}`): VoiceRemovalMember {
  return { dbId, meta: { groupId, voiceIndex, label } };
}

function makeStubHost(initial: Record<string, unknown> = {}): {
  data: Map<string, unknown>;
  host: { getSceneData: jest.Mock; setSceneData: jest.Mock };
} {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    data,
    host: {
      getSceneData: jest.fn(async (_scene: string, key: string) => data.get(key) ?? null),
      setSceneData: jest.fn(async (_scene: string, key: string, value: unknown) => {
        data.set(key, value);
      }),
    },
  };
}

describe('planVoiceRemoval', () => {
  it('drops the deleted member and keeps voiceIndex order', () => {
    const plan = planVoiceRemoval([member('c', 2), member('a', 0), member('b', 1)], 'b');
    expect(plan.survivors.map((m) => m.dbId)).toEqual(['a', 'c']);
    expect(plan.anchorDbId).toBe('a');
    expect(plan.newAnchorDbId).toBeNull();
  });

  it('promotes the lowest surviving voice when the anchor is deleted', () => {
    const plan = planVoiceRemoval([member('a', 0), member('b', 1), member('c', 2)], 'a');
    expect(plan.newAnchorDbId).toBe('b');
  });

  it('falls back to the first member as anchor when no voiceIndex 0 exists', () => {
    const plan = planVoiceRemoval([member('b', 1), member('c', 2)], 'b');
    expect(plan.anchorDbId).toBe('b');
    expect(plan.newAnchorDbId).toBe('c');
  });

  it('reports no handoff when the last voice is deleted', () => {
    const plan = planVoiceRemoval([member('a', 0)], 'a');
    expect(plan.survivors).toEqual([]);
    expect(plan.newAnchorDbId).toBeNull();
  });
});

describe('prepareVoiceRemoval', () => {
  const members = [member('a', 0), member('b', 1), member('c', 2)];

  it('shrinks the stored voice count on a non-anchor delete (rate/split kept)', async () => {
    const { data, host } = makeStubHost({
      [keyFor('a', ARP_CONFIG_KEY)]: { voiceCount: 3, rate: '1/16', split: 'vertical' },
    });
    await prepareVoiceRemoval({ host, sceneId: 's', keyFor, members, deletedDbId: 'c' });
    expect(data.get(keyFor('a', ARP_CONFIG_KEY))).toEqual({
      voiceCount: 2,
      rate: '1/16',
      split: 'vertical',
    });
    // No handoff: survivor metas untouched, no prompt copy.
    expect(host.setSceneData).toHaveBeenCalledTimes(1);
  });

  it('does not invent a config when none is stored', async () => {
    const { host } = makeStubHost();
    await prepareVoiceRemoval({ host, sceneId: 's', keyFor, members, deletedDbId: 'c' });
    expect(host.setSceneData).not.toHaveBeenCalled();
  });

  it('hands the group to the next voice when the anchor is deleted', async () => {
    const { data, host } = makeStubHost({
      [keyFor('a', ARP_CONFIG_KEY)]: { voiceCount: 3, rate: '1/8', split: 'horizontal' },
      [keyFor('a', 'prompt')]: 'shimmering trance arp',
    });
    await prepareVoiceRemoval({ host, sceneId: 's', keyFor, members, deletedDbId: 'a' });

    // Config + prompt moved to the new anchor, count shrunk.
    expect(data.get(keyFor('b', ARP_CONFIG_KEY))).toEqual({
      voiceCount: 2,
      rate: '1/8',
      split: 'horizontal',
    });
    expect(data.get(keyFor('b', 'prompt'))).toBe('shimmering trance arp');

    // Survivors re-pointed; the new anchor takes voiceIndex 0, labels kept.
    expect(data.get(keyFor('b', ARP_VOICE_META_KEY))).toEqual<ArpVoiceMeta>({
      groupId: 'b',
      voiceIndex: 0,
      label: 'v1',
    });
    expect(data.get(keyFor('c', ARP_VOICE_META_KEY))).toEqual<ArpVoiceMeta>({
      groupId: 'b',
      voiceIndex: 2,
      label: 'v2',
    });
  });

  it('skips the prompt copy when the anchor prompt is empty', async () => {
    const { data, host } = makeStubHost({
      [keyFor('a', 'prompt')]: '   ',
    });
    await prepareVoiceRemoval({ host, sceneId: 's', keyFor, members, deletedDbId: 'a' });
    expect(data.has(keyFor('b', 'prompt'))).toBe(false);
    // Handoff still re-points the survivors.
    expect(data.get(keyFor('b', ARP_VOICE_META_KEY))).toMatchObject({ groupId: 'b', voiceIndex: 0 });
  });

  it('clamps the shrunk voice count into the closed domain', async () => {
    const two = [member('a', 0), member('b', 1)];
    const { data, host } = makeStubHost({
      [keyFor('a', ARP_CONFIG_KEY)]: { voiceCount: 2, rate: '1/16', split: 'vertical' },
    });
    await prepareVoiceRemoval({ host, sceneId: 's', keyFor, members: two, deletedDbId: 'b' });
    const cfg = data.get(keyFor('a', ARP_CONFIG_KEY)) as { voiceCount: number };
    expect(cfg.voiceCount).toBe(1); // ARP_MIN_VOICES
  });

  it('is a no-op for the last voice and for a missing selector', async () => {
    const solo = makeStubHost({
      [keyFor('a', ARP_CONFIG_KEY)]: { voiceCount: 1, rate: '1/16', split: 'vertical' },
    });
    await prepareVoiceRemoval({
      host: solo.host,
      sceneId: 's',
      keyFor,
      members: [member('a', 0)],
      deletedDbId: 'a',
    });
    expect(solo.host.setSceneData).not.toHaveBeenCalled();

    const miss = makeStubHost();
    await prepareVoiceRemoval({ host: miss.host, sceneId: 's', keyFor, members, deletedDbId: 'zzz' });
    expect(miss.host.setSceneData).not.toHaveBeenCalled();
    expect(miss.host.getSceneData).not.toHaveBeenCalled();
  });
});
