/**
 * Arp voice-group metadata — the ensemble plugin's voice-group shape,
 * verbatim discipline: membership is per-member scene-data under
 * `track:<dbId>:arpVoice`, the anchor is voiceIndex 0 and carries the group
 * prompt under the standard prompt key, and regeneration reconciles
 * positionally (reused voices KEEP the user's presets).
 */

import type {
  GroupParseSpec,
  ResolvedTrackGroup,
  GeneratorTrackState,
} from '@signalsandsorcery/plugin-sdk';
import { ARP_RATES, ARP_SPLITS, type ArpRate, type ArpSplit } from './arp-core';

export const ARP_VOICE_META_KEY = 'arpVoice';
/** Anchor-held arp config (voiceCount + rate + split), same scene-data channel. */
export const ARP_CONFIG_KEY = 'arpConfig';

export interface ArpVoiceMeta {
  /** dbId of the anchor (voice 0). */
  groupId: string;
  /** 0 = top band / first bar rotation; increases downward. */
  voiceIndex: number;
  /** Mechanical label shown in the voice row ("top band", "even bars"). */
  label: string;
}

export function asArpVoiceMeta(val: unknown): ArpVoiceMeta | null {
  if (!val || typeof val !== 'object') return null;
  const m = val as Partial<ArpVoiceMeta>;
  if (typeof m.groupId !== 'string' || typeof m.voiceIndex !== 'number') return null;
  return {
    groupId: m.groupId,
    voiceIndex: m.voiceIndex,
    label: typeof m.label === 'string' ? m.label : '',
  };
}

export const arpVoiceGroupSpec: GroupParseSpec<ArpVoiceMeta> = {
  metaKey: ARP_VOICE_META_KEY,
  asMeta: asArpVoiceMeta,
  groupIdOf: (m) => m.groupId,
  sortMembers: (a, b) => a.meta.voiceIndex - b.meta.voiceIndex,
};

export function arpGroupIsComplete(
  group: ResolvedTrackGroup<ArpVoiceMeta, GeneratorTrackState>,
): boolean {
  return group.members.some((m) => m.meta.voiceIndex === 0);
}

// --- reconcile planner (pure; the ensemble plugin's shape) ---

export interface ReconcileMember {
  dbId: string;
  engineId: string;
  voiceIndex: number;
}

export interface ReconcilePlan {
  reuse: Array<{ dbId: string; engineId: string; bucketIndex: number }>;
  createBucketIndexes: number[];
  remove: Array<{ dbId: string; engineId: string }>;
}

/**
 * Pair existing members with the new voice list positionally: index 0 (the
 * anchor) is always reused, so the groupId and the prompt key never move;
 * extra voices are created, surplus members removed. Reused voices keep
 * their presets unconditionally.
 */
export function planReconcile(existing: ReconcileMember[], bucketCount: number): ReconcilePlan {
  const sorted = [...existing].sort((a, b) => a.voiceIndex - b.voiceIndex);
  const reuse: ReconcilePlan['reuse'] = [];
  const createBucketIndexes: number[] = [];
  const remove: ReconcilePlan['remove'] = [];
  for (let i = 0; i < bucketCount; i++) {
    const member = sorted[i];
    if (member) reuse.push({ dbId: member.dbId, engineId: member.engineId, bucketIndex: i });
    else createBucketIndexes.push(i);
  }
  for (let i = bucketCount; i < sorted.length; i++) {
    remove.push({ dbId: sorted[i].dbId, engineId: sorted[i].engineId });
  }
  return { reuse, createBucketIndexes, remove };
}

// --- arp config (anchor-held) ---

export interface ArpConfig {
  voiceCount: number;
  rate: string;
  split: string;
}

export function asArpConfig(val: unknown): ArpConfig | null {
  if (!val || typeof val !== 'object') return null;
  const c = val as Partial<ArpConfig>;
  if (typeof c.voiceCount !== 'number' || typeof c.rate !== 'string' || typeof c.split !== 'string') {
    return null;
  }
  return { voiceCount: c.voiceCount, rate: c.rate, split: c.split };
}

/**
 * Deterministic prompt hints for the FIRST generate (before the group header
 * with its explicit controls exists): "3 voices" sets the count, "1/16" /
 * "sixteenth" sets the rate, a literal split word sets the split. Explicit
 * config always wins.
 */
export function parsePromptHints(prompt: string): {
  voiceCount?: number;
  rate?: ArpRate;
  split?: ArpSplit;
} {
  const hints: { voiceCount?: number; rate?: ArpRate; split?: ArpSplit } = {};
  const count = /(\d+)\s*[- ]?\s*(?:voice|part|patch|line)s?\b/i.exec(prompt);
  if (count) hints.voiceCount = parseInt(count[1], 10);
  if (/(?:\b|\D)1\/16\b|\b(?:sixteenth|16th)s?\b/i.test(prompt)) hints.rate = '1/16';
  else if (/(?:\b|\D)1\/8\b|\b(?:eighth|8th)s?\b/i.test(prompt)) hints.rate = '1/8';
  else if (/(?:\b|\D)1\/4\b|\bquarters?\b/i.test(prompt)) hints.rate = '1/4';
  if (/\bhorizontal|alternat/i.test(prompt)) hints.split = 'horizontal';
  else if (/\bvertical|stack|band/i.test(prompt)) hints.split = 'vertical';
  return hints;
}

/** Clamp arbitrary stored strings back into the closed domains. */
export function normalizeRate(raw: string | undefined, fallback: ArpRate): ArpRate {
  return (ARP_RATES as readonly string[]).includes(raw ?? '') ? (raw as ArpRate) : fallback;
}

export function normalizeSplit(raw: string | undefined, fallback: ArpSplit): ArpSplit {
  return (ARP_SPLITS as readonly string[]).includes(raw ?? '') ? (raw as ArpSplit) : fallback;
}
