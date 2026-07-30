/**
 * Arp generation strategy — the brain.
 *
 * ONE schema-forced LLM call designs the repeating cell
 * (host.generateWithLLMTools, mode 'ANY', submit_arp tool), then everything
 * is mechanical: expandPattern tiles the cell over the scene's per-bar
 * chords at the chosen rate (chord tones only — the output cannot leave the
 * harmony) and splitVoices partitions the stream vertically (pitch bands)
 * or horizontally (alternating bars) across the voices. An unusable reply
 * earns ONE plain retry (quota-conscious).
 *
 * Track lifecycle follows the ensemble plugin verbatim: positional
 * reconcile (reused voices KEEP the user's presets), clips written before
 * presets, metas last, LIFO rollback on failure, everything spawns muted.
 *
 * NOTE: generateWithLLMTools is a raw Gemini passthrough — unlike
 * generateWithLLM it does NOT auto-prefix the musical context, so this
 * strategy assembles key/BPM/chords/contract + the concurrent-tracks block
 * into the user content itself.
 */

import type {
  GeneratorTrackState,
  GenerationServices,
  PluginTrackHandle,
  MidiClipData,
  LLMToolUseRequest,
  LLMFunctionDeclaration,
} from '@signalsandsorcery/plugin-sdk';
import {
  formatConcurrentTracks,
  panelClipEndSeconds,
  panelMeter,
  panelQuarterNotesPerBar,
} from '@signalsandsorcery/plugin-sdk';
import {
  buildArpSystemPrompt,
  buildSubmitArpParameters,
  expandPattern,
  parseArpArgs,
  splitVoices,
  voiceLabel,
  SUBMIT_ARP_TOOL_NAME,
  STEPS_PER_BEAT,
  ARP_MIN_VOICES,
  ARP_MAX_VOICES,
  type ArpNote,
  type ArpRate,
  type ArpSplit,
} from './arp-core';
import {
  ARP_CONFIG_KEY,
  ARP_VOICE_META_KEY,
  asArpConfig,
  normalizeRate,
  normalizeSplit,
  parsePromptHints,
  planReconcile,
  type ArpVoiceMeta,
  type ReconcileMember,
} from './arp-voice-meta';
import { chordLookupsFromTiming, notePcFor, scalePcsFor } from './music-helpers';

export const ARP_MAX_TRACKS = 12;
export const DEFAULT_VOICE_COUNT = 2;
export const DEFAULT_RATE: ArpRate = '1/16';
export const DEFAULT_SPLIT: ArpSplit = 'vertical';
/** The generation model — tools-capable; matches the platform's BEST tier. */
export const ARP_MODEL = 'gemini-3.1-pro-preview';
export const ARP_MAX_OUTPUT_TOKENS = 4096;
export const ARP_TEMPERATURE = 0.9;

/** Every arp voice carries the canonical 'arp' role (→ synths-hi/low presets). */
export const ARP_TRACK_ROLE = 'arp';

/**
 * Sibling roles pinned as budget-exempt REFERENCE tracks before the cell
 * call (drum-interplay follow-on, 2026-07-30). Hat-family tracks define the
 * subdivision grid the interlock prompt line writes against; kick/808/bass
 * are the groove anchors that would otherwise be auto-pinned by the host —
 * explicit pins suppress that auto-pin, so they must be listed here. Both
 * raw drum-folder roles (drum panel: 'hat-closed', 'kick') and the coarse
 * canonical roles (agent Path B: 'hats', 'kicks') are matched, lowercased.
 */
export const ARP_INTERLOCK_PIN_ROLES: ReadonlySet<string> = new Set([
  'hat-closed',
  'hat-open',
  'cymbal-ride',
  'hats',
  'kick',
  'kicks',
  '808',
  '808s',
  'bass',
]);

interface FilledVoice {
  voiceIndex: number;
  label: string;
  notes: ArpNote[];
}

export async function generateArp(
  track: GeneratorTrackState,
  services: GenerationServices
): Promise<void> {
  const { host } = services;
  const scene = services.activeSceneId;
  if (!scene) throw new Error('No active scene — select a scene first.');
  const prompt = (track.prompt ?? '').trim();
  if (!prompt) throw new Error('Describe the arp first (e.g. "glassy trance arp, 2 voices, 1/16").');

  // ── group / anchor resolution (ensemble shape) ─────────────────────────
  const groups = services.resolvedGroups<ArpVoiceMeta>(ARP_VOICE_META_KEY);
  const promptedDbId = track.handle.dbId;
  const existingGroup = groups.find((g) => g.members.some((m) => m.dbId === promptedDbId)) ?? null;
  const anchorMember = existingGroup?.members.find((m) => m.meta.voiceIndex === 0);
  const anchorTrack = anchorMember ? anchorMember.track : track;
  const anchorDbId = anchorTrack.handle.dbId;
  const anchorPrompt = (anchorTrack.prompt ?? '').trim() || prompt;

  // ── config: stored (header controls) > prompt hints > defaults ────────
  const storedRaw = await host
    .getSceneData(scene, services.trackDataKey(anchorDbId, ARP_CONFIG_KEY))
    .catch(() => null);
  const stored = asArpConfig(storedRaw);
  const hints = parsePromptHints(anchorPrompt);
  const rate = normalizeRate(stored?.rate, hints.rate ?? DEFAULT_RATE);
  const split = normalizeSplit(stored?.split, hints.split ?? DEFAULT_SPLIT);
  const voiceCount = Math.max(
    ARP_MIN_VOICES,
    Math.min(ARP_MAX_VOICES, stored?.voiceCount ?? hints.voiceCount ?? DEFAULT_VOICE_COUNT)
  );

  // ── musical + sibling context (tools path has NO auto-prefix) ─────────
  const musical = await host.getMusicalContext();
  const bars = musical.bars > 0 ? musical.bars : 4;
  const bpm = musical.bpm > 0 ? musical.bpm : 120;
  // Scene meter (P8b): '4/4' for absent/malformed values — every derived
  // number below then reproduces the legacy 4/4 arithmetic exactly.
  const meter = panelMeter(musical);
  const qnPerBar = panelQuarterNotesPerBar(musical);

  let concurrentBlock = '';
  try {
    // Don't make the model write "around" its own previous voices.
    const groupDbIds = new Set((existingGroup?.members ?? []).map((m) => m.dbId));
    groupDbIds.add(anchorDbId);
    // Pin the grid-defining siblings (hats/ride) as budget-exempt REFERENCE
    // tracks — dense 16th hats are exactly the high-note-count, low-priority
    // tracks the cross-track budget drops first, and the interlock prompt
    // line needs their onsets present. The kick/808/bass anchors ride along
    // because EXPLICIT pins fully suppress the host's groove-leader auto-pin.
    let pinTrackDbIds: string[] = [];
    try {
      const sceneTracks = (await host.listSceneTracks?.()) ?? [];
      pinTrackDbIds = sceneTracks
        .filter(
          (t) =>
            t.hasMidi &&
            !groupDbIds.has(t.dbId) &&
            t.role !== undefined &&
            ARP_INTERLOCK_PIN_ROLES.has(t.role.trim().toLowerCase())
        )
        .map((t) => t.dbId);
    } catch {
      /* pin discovery is best-effort — auto-pin covers the no-pin path */
    }
    const genCtx =
      pinTrackDbIds.length > 0
        ? await host.getGenerationContext(anchorTrack.handle.id, { pinTrackDbIds })
        : await host.getGenerationContext(anchorTrack.handle.id);
    concurrentBlock = formatConcurrentTracks({
      ...genCtx,
      concurrentTracks: genCtx.concurrentTracks.filter(
        (t) => !(t.dbId !== undefined && groupDbIds.has(t.dbId))
      ),
    });
  } catch {
    /* sibling context is best-effort, never a gate */
  }

  const chordText = musical.chordProgression.length > 0
    ? musical.chordProgression.map((c) => `${c.symbol} (beats ${c.startQn}-${c.endQn})`).join(', ')
    : 'none';
  const contextText = [
    'Musical Context:',
    `- Key: ${musical.key} ${musical.mode}`,
    `- BPM: ${bpm}`,
    // 4/4 renders `bars * 4` exactly (byte-identity); the meter line only
    // appears on non-4/4 scenes.
    `- Bars: ${bars} (clip = ${bars * qnPerBar} quarter-note beats)`,
    meter !== '4/4' ? `- Time signature: ${meter} (each bar = ${qnPerBar} quarter notes)` : null,
    musical.genre ? `- Genre: ${musical.genre}` : null,
    `- Chord Progression: ${chordText}`,
    musical.contractPrompt ? `- Scene Contract: ${musical.contractPrompt}` : null,
  ].filter(Boolean).join('\n');

  const systemPrompt = buildArpSystemPrompt({ voiceCount, rate, split, bars, timeSignature: meter });
  const baseUser = `${contextText}\n\n${concurrentBlock ? `${concurrentBlock}\n\n` : ''}User request: "${anchorPrompt}"`;

  // ── the cell call (+ at most ONE plain retry on an unusable reply) ────
  const submitDeclaration: LLMFunctionDeclaration = {
    name: SUBMIT_ARP_TOOL_NAME,
    description: 'Submit the repeating arp cell as structured grid steps.',
    parameters: buildSubmitArpParameters() as LLMFunctionDeclaration['parameters'],
  };

  const callModel = async (userText: string): Promise<ReturnType<typeof parseArpArgs>> => {
    const request: LLMToolUseRequest = {
      model: ARP_MODEL,
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      tools: [{ functionDeclarations: [submitDeclaration] }],
      toolConfig: {
        functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [SUBMIT_ARP_TOOL_NAME] },
      },
      generationConfig: {
        temperature: ARP_TEMPERATURE,
        maxOutputTokens: ARP_MAX_OUTPUT_TOKENS,
      },
    };
    const response = await host.generateWithLLMTools(request);
    for (const candidate of response.candidates ?? []) {
      for (const part of candidate.content?.parts ?? []) {
        if (part.functionCall && part.functionCall.name === SUBMIT_ARP_TOOL_NAME) {
          return parseArpArgs(part.functionCall.args);
        }
      }
    }
    return null;
  };

  let pattern = await callModel(baseUser);
  if (!pattern) {
    pattern = await callModel(
      `${baseUser}\n\nYour previous reply was unusable. Call ${SUBMIT_ARP_TOOL_NAME} with 4-32 steps and at least one non-rest step.`
    ).catch(() => null);
  }
  if (!pattern) {
    throw new Error('The model returned no usable arp cell — try rephrasing the prompt.');
  }

  // ── mechanical expansion + split ───────────────────────────────────────
  const scalePcs = scalePcsFor(musical.key, musical.mode) ?? undefined;
  // Bar windows in the scene meter (4/4 = the legacy bar*4 grid) — the arp
  // re-roots per BAR, so boundaries are bars×qn, never denominator slots.
  const { chordRootPcAtBar, chordPcsAtBar } = chordLookupsFromTiming(musical.chordProgression, meter);
  const notes = expandPattern(pattern, {
    bars,
    stepsPerBeat: STEPS_PER_BEAT[rate],
    chordRootPcAtBar,
    chordPcsAtBar,
    scalePcs,
    fallbackRootPc: notePcFor(musical.key) ?? 0,
    quarterNotesPerBar: qnPerBar,
  });
  if (notes.length === 0) {
    throw new Error('The arp cell expanded to no notes — try a denser pattern.');
  }

  // Voices the split left empty are dropped (fewer tracks, never empty clips).
  const filled: FilledVoice[] = splitVoices(notes, voiceCount, split)
    .map((voiceNotes, i) => ({
      voiceIndex: i,
      label: voiceLabel(split, i, voiceCount),
      notes: voiceNotes,
    }))
    .filter((v) => v.notes.length > 0)
    .map((v, i) => ({ ...v, voiceIndex: i }));

  // ── reconcile + budget ─────────────────────────────────────────────────
  const existingMembers: ReconcileMember[] = existingGroup
    ? existingGroup.members.map((m) => ({
        dbId: m.dbId,
        engineId: m.track.handle.id,
        voiceIndex: m.meta.voiceIndex,
      }))
    : [{ dbId: anchorDbId, engineId: anchorTrack.handle.id, voiceIndex: 0 }];
  const plan = planReconcile(existingMembers, filled.length);
  const liveCount = services.tracks.length;
  if (liveCount - plan.remove.length + plan.createBucketIndexes.length > ARP_MAX_TRACKS) {
    throw new Error(
      `This arp would exceed the ${ARP_MAX_TRACKS}-track panel budget — reduce the voice count or delete tracks first.`
    );
  }

  const clipFor = (voiceNotes: ArpNote[]): MidiClipData => ({
    startTime: 0,
    // Scene-loop span in the scene meter (4/4 = the legacy bars*4*60/bpm).
    endTime: panelClipEndSeconds({ bars, bpm, timeSignature: meter }),
    tempo: bpm,
    notes: voiceNotes.map((n) => ({
      pitch: n.pitch,
      startBeat: n.startBeat,
      durationBeats: n.durationBeats,
      velocity: n.velocity,
      channel: 0,
    })),
  });

  // ── execute: create → clips → role+mute → presets (new only) → metas ──
  const created: PluginTrackHandle[] = [];
  try {
    const memberByBucket = new Map<number, { engineId: string; dbId: string; isNew: boolean }>();
    for (const r of plan.reuse) {
      memberByBucket.set(r.bucketIndex, { engineId: r.engineId, dbId: r.dbId, isNew: false });
    }
    for (const bucketIndex of plan.createBucketIndexes) {
      const handle = await services.createFamilyTrack(`-v${bucketIndex}`);
      created.push(handle);
      memberByBucket.set(bucketIndex, { engineId: handle.id, dbId: handle.dbId, isNew: true });
    }

    // Clips FIRST (preset range-analysis reads real pitches), then role + mute.
    for (let i = 0; i < filled.length; i++) {
      const member = memberByBucket.get(i)!;
      await host.writeMidiClip(member.engineId, clipFor(filled[i].notes));
      await host.setTrackRole(member.engineId, ARP_TRACK_ROLE).catch(() => {});
      await host.setTrackMute(member.engineId, true).catch(() => {});
      if (!member.isNew) {
        services.updateTrack(member.engineId, (t) => ({
          ...t,
          runtimeState: { ...t.runtimeState, muted: true },
        }));
      }
    }

    // Presets: 🔗 Apply All groups share ONE sound; otherwise per-voice shuffle.
    const linkSounds = stored?.linkSounds === true;
    if (linkSounds && services.sound && host.getTrackSound) {
      // Every voice carries the group's shared sound — the anchor's durable
      // identity. First-ever generation (no persisted anchor preset yet):
      // shuffle the ANCHOR once (the host persists it), then copy to the rest.
      let snap = await host.getTrackSound(anchorDbId).catch(() => null);
      if (!snap || snap.kind !== 'preset') {
        try {
          await host.shufflePreset(anchorTrack.handle.id, [], { description: prompt });
          snap = await host.getTrackSound(anchorDbId).catch(() => null);
        } catch {
          /* non-fatal — voices fall back to default patches */
        }
      }
      if (snap && snap.kind === 'preset') {
        for (let i = 0; i < filled.length; i++) {
          const member = memberByBucket.get(i)!;
          // Reused voices keep their sound — it IS the shared sound.
          if (!member.isNew) continue;
          try {
            await services.sound.copySnapshot(member.engineId, snap);
          } catch {
            /* non-fatal — default patch */
          }
        }
      }
    } else {
      // Presets for NEW voices only — reused voices keep the user's pick.
      const appliedNames: string[] = [];
      for (let i = 0; i < filled.length; i++) {
        const member = memberByBucket.get(i)!;
        if (!member.isNew) continue;
        try {
          // Pass the arp prompt so the host's semantic (vector-proximity)
          // retrieval picks by timbre instead of random-within-category.
          const result = await host.shufflePreset(member.engineId, appliedNames, {
            description: prompt,
          });
          appliedNames.push(result.presetName);
        } catch {
          /* non-fatal — default patch */
        }
      }
    }

    // Metas LAST — a mid-flight failure above leaves the OLD group intact.
    for (let i = 0; i < filled.length; i++) {
      const member = memberByBucket.get(i)!;
      const meta: ArpVoiceMeta = {
        groupId: anchorDbId,
        voiceIndex: i,
        label: filled[i].label,
      };
      await host.setSceneData(scene, services.trackDataKey(member.dbId, ARP_VOICE_META_KEY), meta);
    }
    await host.setSceneData(scene, services.trackDataKey(anchorDbId, ARP_CONFIG_KEY), {
      voiceCount,
      rate,
      split,
      // Carry 🔗 Apply All through the rewrite — the validator strips unknown
      // fields, so dropping it here would silently turn the toggle off.
      ...(stored?.linkSounds === undefined ? {} : { linkSounds: stored.linkSounds }),
    });

    // Surplus voices: delete track + its group/soundHistory keys.
    for (const surplus of plan.remove) {
      await host.deleteTrack(surplus.engineId).catch(() => {});
      await host
        .deleteSceneData(scene, services.trackDataKey(surplus.dbId, ARP_VOICE_META_KEY))
        .catch(() => {});
      await host
        .deleteSceneData(scene, services.trackDataKey(surplus.dbId, 'soundHistory'))
        .catch(() => {});
    }
  } catch (err) {
    // LIFO rollback — remove any tracks created this pass, newest first.
    for (const handle of [...created].reverse()) {
      try {
        await host.deleteTrack(handle.id);
      } catch {
        /* best effort */
      }
      await host
        .deleteSceneData(scene, services.trackDataKey(handle.dbId, ARP_VOICE_META_KEY))
        .catch(() => {});
    }
    throw err instanceof Error ? err : new Error(String(err));
  }

  // ── success patch on the anchor + reload ──────────────────────────────
  services.updateTrack(anchorTrack.handle.id, (t) => ({
    ...t,
    isGenerating: false,
    error: null,
    role: ARP_TRACK_ROLE,
    hasMidi: true,
    generationProgress: 0,
    editNotes: clipFor(filled[0].notes).notes,
    editBars: bars,
    editBpm: bpm,
    editBeatsPerBar: qnPerBar,
  }));
  services.markEditLoaded(anchorTrack.handle.id);
  host.showToast(
    'success',
    'Arp generated',
    `${filled.length} voice${filled.length === 1 ? '' : 's'} · ${rate} · ${split}` +
      (pattern.warnings.length > 0 ? ` · ${pattern.warnings.length} cell note(s)` : '')
  );
  await services.reloadTracks(true);
}
