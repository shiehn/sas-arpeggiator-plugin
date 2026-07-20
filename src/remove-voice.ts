/**
 * Per-voice removal — the "delete ONE voice" counterpart of the group ✕.
 *
 * Deleting a non-anchor voice is a plain track delete plus a stored-config
 * voice-count shrink, so the header dropdown (and the next Generate) match
 * what's left. Deleting the ANCHOR (voice 0) additionally hands the group
 * identity to the next surviving voice: the prompt + config move to the new
 * anchor's keys and every survivor's meta is re-pointed (groupId = new
 * anchor dbId, new anchor takes voiceIndex 0) BEFORE the old anchor's track
 * and keys are scrubbed — the group must never reload through an anchorless
 * (degraded-to-loose-rows) state.
 *
 * The caller runs this surgery FIRST, then `ctx.deleteGroup([deleted], …)`
 * with the same suffix list the whole-group ✕ uses: the anchor-held keys
 * either moved here already or belong to the last remaining voice.
 */

import { ARP_MAX_VOICES, ARP_MIN_VOICES } from './arp-core';
import {
  ARP_CONFIG_KEY,
  ARP_VOICE_META_KEY,
  asArpConfig,
  type ArpVoiceMeta,
} from './arp-voice-meta';

/** The slice of PluginHost the surgery needs (kept narrow for tests). */
export interface VoiceRemovalHost {
  getSceneData(sceneId: string, key: string): Promise<unknown>;
  setSceneData(sceneId: string, key: string, value: unknown): Promise<void>;
}

export interface VoiceRemovalMember {
  dbId: string;
  meta: ArpVoiceMeta;
}

export interface VoiceRemovalPlan {
  /** Members left after the delete, sorted by voiceIndex. */
  survivors: VoiceRemovalMember[];
  /** The group's anchor BEFORE the delete (voiceIndex 0, or first member). */
  anchorDbId: string | null;
  /** Set when the anchor itself is deleted and survivors remain. */
  newAnchorDbId: string | null;
}

export function planVoiceRemoval(
  members: VoiceRemovalMember[],
  deletedDbId: string,
): VoiceRemovalPlan {
  const sorted = [...members].sort((a, b) => a.meta.voiceIndex - b.meta.voiceIndex);
  const anchor = sorted.find((m) => m.meta.voiceIndex === 0) ?? sorted[0];
  const survivors = sorted.filter((m) => m.dbId !== deletedDbId);
  const anchorDeleted = anchor !== undefined && anchor.dbId === deletedDbId;
  return {
    survivors,
    anchorDbId: anchor?.dbId ?? null,
    newAnchorDbId: anchorDeleted && survivors.length > 0 ? survivors[0].dbId : null,
  };
}

const clampVoiceCount = (n: number): number =>
  Math.max(ARP_MIN_VOICES, Math.min(ARP_MAX_VOICES, n));

/**
 * Scene-data surgery for removing one voice. No-op when the selector misses
 * or when the deleted voice is the LAST one (the caller's deleteGroup scrub
 * is the whole cleanup then). Never invents a config: when no config blob is
 * stored (pre-first-generate), hints/defaults keep resolving the count.
 */
export async function prepareVoiceRemoval(opts: {
  host: VoiceRemovalHost;
  sceneId: string;
  keyFor: (dbId: string, suffix: string) => string;
  members: VoiceRemovalMember[];
  deletedDbId: string;
}): Promise<void> {
  const { host, sceneId, keyFor, members, deletedDbId } = opts;
  const plan = planVoiceRemoval(members, deletedDbId);
  if (plan.survivors.length === members.length) return; // selector missed
  if (plan.survivors.length === 0 || plan.anchorDbId === null) return; // last voice

  const configHolder = plan.newAnchorDbId ?? plan.anchorDbId;
  const cfg = asArpConfig(
    await host.getSceneData(sceneId, keyFor(plan.anchorDbId, ARP_CONFIG_KEY)),
  );
  if (cfg) {
    await host.setSceneData(sceneId, keyFor(configHolder, ARP_CONFIG_KEY), {
      ...cfg,
      voiceCount: clampVoiceCount(plan.survivors.length),
    });
  }

  if (plan.newAnchorDbId) {
    const prompt = await host.getSceneData(sceneId, keyFor(plan.anchorDbId, 'prompt'));
    if (typeof prompt === 'string' && prompt.trim() !== '') {
      await host.setSceneData(sceneId, keyFor(plan.newAnchorDbId, 'prompt'), prompt);
    }
    for (const s of plan.survivors) {
      const meta: ArpVoiceMeta = {
        ...s.meta,
        groupId: plan.newAnchorDbId,
        voiceIndex: s.dbId === plan.newAnchorDbId ? 0 : s.meta.voiceIndex,
      };
      await host.setSceneData(sceneId, keyFor(s.dbId, ARP_VOICE_META_KEY), meta);
    }
  }
}
