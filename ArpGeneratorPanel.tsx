/**
 * Arp panel — a thin GeneratorPanelAdapter over the SDK panel-core (the
 * ensemble plugin's container with a different brain). One voice-group per
 * arp: the anchor (voice 0) carries the prompt; the group header adds the
 * three explicit intent controls — voice count (1-4), rate (1/4, 1/8, 1/16)
 * and split (vertical / horizontal) — persisted in scene-data under the
 * anchor (`track:<anchorDbId>:arpConfig`).
 *
 * Per-voice sound choice stays mechanical: every voice carries the 'arp'
 * role and its actual register drives shufflePreset's category pick,
 * exactly like every other generator.
 */

import React, { useEffect, useMemo, useState } from 'react';
import type {
  PluginUIProps,
  PluginHost,
  PluginTrackHandle,
  GeneratorPanelAdapter,
  GeneratorTrackState,
  GroupRenderContext,
  ResolvedTrackGroup,
} from '@signalsandsorcery/plugin-sdk';
import {
  GeneratorPanelShell,
  useGeneratorPanelCore,
  createSurgeSoundAdapter,
  ConfirmDialog,
  parseLLMNoteResponse,
} from '@signalsandsorcery/plugin-sdk';
import {
  ARP_RATES,
  ARP_SPLITS,
  ARP_MIN_VOICES,
  ARP_MAX_VOICES,
  buildArpSystemPrompt,
  type ArpRate,
  type ArpSplit,
} from './src/arp-core';
import {
  ARP_CONFIG_KEY,
  ARP_VOICE_META_KEY,
  asArpConfig,
  arpGroupIsComplete,
  arpVoiceGroupSpec,
  normalizeRate,
  normalizeSplit,
  stampArpAnchor,
  type ArpVoiceMeta,
} from './src/arp-voice-meta';
import {
  generateArp,
  ARP_MAX_TRACKS,
  DEFAULT_VOICE_COUNT,
  DEFAULT_RATE,
  DEFAULT_SPLIT,
} from './src/arp-generation';

const ESTIMATED_GENERATION_MS = 15000; // one small cell call + a possible retry

// ============================================================================
// Group row — header (prompt + voices + rate + split + Generate + M/S/✕),
// voice rows
// ============================================================================

function ArpVoiceGroupRow({
  group,
  ctx,
}: {
  group: ResolvedTrackGroup<ArpVoiceMeta, GeneratorTrackState>;
  ctx: GroupRenderContext;
}): React.ReactElement {
  const anchor = group.members.find((m) => m.meta.voiceIndex === 0) ?? group.members[0];
  const anchorTrack = anchor.track;
  const scene = ctx.services.activeSceneId;
  const host = ctx.services.host;
  const configKey = ctx.services.trackDataKey(anchor.dbId, ARP_CONFIG_KEY);

  const [voiceCount, setVoiceCount] = useState<number>(DEFAULT_VOICE_COUNT);
  const [rate, setRate] = useState<ArpRate>(DEFAULT_RATE);
  const [split, setSplit] = useState<ArpSplit>(DEFAULT_SPLIT);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!scene) return undefined;
    void host.getSceneData(scene, configKey).then((raw) => {
      const cfg = asArpConfig(raw);
      if (cfg && !cancelled) {
        setVoiceCount(Math.max(ARP_MIN_VOICES, Math.min(ARP_MAX_VOICES, cfg.voiceCount)));
        setRate(normalizeRate(cfg.rate, DEFAULT_RATE));
        setSplit(normalizeSplit(cfg.split, DEFAULT_SPLIT));
      }
    }).catch(() => {});
    return () => { cancelled = true; };
    // members.length: a generation can rewrite the stored config (hints on the
    // first run) — re-sync the header controls when the group's shape changes.
  }, [host, scene, configKey, group.members.length]);

  const persistConfig = (next: { voiceCount: number; rate: ArpRate; split: ArpSplit }): void => {
    if (!scene) return;
    void host.setSceneData(scene, configKey, next).catch(() => {});
  };

  const memberEngineIds = group.members.map((m) => m.track.handle.id);
  const allMuted = group.members.every((m) => m.track.runtimeState.muted);
  const anySolo = group.members.some((m) => m.track.runtimeState.solo);
  const isGenerating = group.members.some((m) => m.track.isGenerating);
  const generateDisabled = isGenerating || !anchorTrack.prompt.trim();

  return (
    <div
      data-testid={`arp-group-${group.groupId}`}
      className="rounded-sm border border-sas-border bg-sas-panel-alt overflow-hidden"
      style={{ borderLeftColor: '#06B6D4', borderLeftWidth: '3px' }}
    >
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-sas-border">
        <span className="text-[9px] uppercase tracking-wide text-sas-muted whitespace-nowrap">
          Arp · {group.members.length} {group.members.length === 1 ? 'voice' : 'voices'}
        </span>
        <input
          type="text"
          value={anchorTrack.prompt}
          placeholder="Describe the arp…"
          onChange={(e) => ctx.handlers.promptChange(anchorTrack.handle.id, e.target.value)}
          className="flex-1 min-w-0 bg-sas-panel border border-sas-border rounded-sm px-2 py-0.5 text-xs text-sas-text placeholder:text-sas-muted/50 focus:border-sas-accent focus:outline-none"
          data-testid="arp-group-prompt"
        />
        <select
          value={voiceCount}
          onChange={(e) => {
            const next = parseInt(e.target.value, 10);
            setVoiceCount(next);
            persistConfig({ voiceCount: next, rate, split });
          }}
          title="Voices"
          className="text-xs bg-sas-panel border border-sas-border rounded-sm px-1 py-0.5 text-sas-text"
          data-testid="arp-voice-count"
        >
          {Array.from({ length: ARP_MAX_VOICES - ARP_MIN_VOICES + 1 }, (_, i) => ARP_MIN_VOICES + i).map((n) => (
            <option key={n} value={n}>{n} {n === 1 ? 'voice' : 'voices'}</option>
          ))}
        </select>
        <select
          value={rate}
          onChange={(e) => {
            const next = e.target.value as ArpRate;
            setRate(next);
            persistConfig({ voiceCount, rate: next, split });
          }}
          title="Rate"
          className="text-xs bg-sas-panel border border-sas-border rounded-sm px-1 py-0.5 text-sas-text"
          data-testid="arp-rate"
        >
          {ARP_RATES.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <select
          value={split}
          onChange={(e) => {
            const next = e.target.value as ArpSplit;
            setSplit(next);
            persistConfig({ voiceCount, rate, split: next });
          }}
          title="Split — vertical: pitch bands per voice; horizontal: alternating bars per voice"
          className="text-xs bg-sas-panel border border-sas-border rounded-sm px-1 py-0.5 text-sas-text"
          data-testid="arp-split"
        >
          {ARP_SPLITS.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <button
          onClick={() => ctx.handlers.generate(anchorTrack.handle.id)}
          disabled={generateDisabled}
          title="Regenerate the whole arp"
          className={`px-2 py-0.5 text-[10px] font-medium rounded-sm border transition-colors ${
            generateDisabled
              ? 'bg-sas-panel border-sas-border text-sas-muted/50 cursor-not-allowed'
              : 'bg-sas-accent/10 border-sas-accent/30 text-sas-accent hover:bg-sas-accent/20'
          }`}
          data-testid="arp-generate"
        >
          {isGenerating ? 'Generating…' : 'Generate'}
        </button>
        <button
          onClick={() => ctx.setGroupMute(memberEngineIds, !allMuted)}
          title="Mute group"
          className={`px-1.5 py-0.5 text-[10px] font-bold rounded-sm border transition-colors ${
            allMuted
              ? 'bg-red-500/20 border-red-500/40 text-red-400'
              : 'bg-sas-panel border-sas-border text-sas-muted hover:border-sas-accent'
          }`}
        >
          M
        </button>
        <button
          onClick={() => ctx.setGroupSolo(memberEngineIds, !anySolo)}
          title="Solo group"
          className={`px-1.5 py-0.5 text-[10px] font-bold rounded-sm border transition-colors ${
            anySolo
              ? 'bg-yellow-500/20 border-yellow-500/40 text-yellow-400'
              : 'bg-sas-panel border-sas-border text-sas-muted hover:border-sas-accent'
          }`}
        >
          S
        </button>
        <button
          onClick={() => setConfirmDelete(true)}
          title="Delete arp"
          className="px-1.5 py-0.5 text-[10px] rounded-sm border border-sas-border text-sas-muted hover:border-red-500/60 hover:text-red-400 transition-colors"
        >
          ✕
        </button>
      </div>

      <div className="p-1 space-y-1">
        {group.members.map((m) =>
          ctx.renderDefaultTrackRow(m.track, {
            // The prompt field shows the MECHANICAL voice label ("top band",
            // "even bars"); the arp intent lives on the group header (the
            // anchor's prompt key). Voice count is owned by the header
            // dropdown, so per-voice generate/delete/copy are off (the group
            // owns those).
            prompt: m.meta.label || 'arp voice',
            onPromptChange: undefined,
            onGenerate: undefined,
            onCopy: undefined,
            onDelete: undefined,
          }),
        )}
      </div>

      {confirmDelete && (
        <ConfirmDialog
          open={confirmDelete}
          title="Delete arp?"
          message={`Removes all ${group.members.length} voice tracks of this arp.`}
          confirmLabel="Delete"
          onConfirm={() => {
            setConfirmDelete(false);
            void ctx.deleteGroup(
              group.members.map((m) => ({ engineId: m.track.handle.id, dbId: m.dbId })),
              [ARP_VOICE_META_KEY, ARP_CONFIG_KEY, 'prompt', 'soundHistory', 'role'],
            );
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}

// ============================================================================
// Adapter + panel
// ============================================================================

function createArpGeneratorAdapter(host: PluginHost): GeneratorPanelAdapter<ArpVoiceMeta> {
  const surgeSound = createSurgeSoundAdapter(host);
  return {
    identity: {
      familyKey: 'arp',
      familyLabel: 'Arp',
      trackNamePrefix: 'arp',
      logTag: 'ArpGeneratorPanel',
      accentColor: '#06B6D4',
      transitionAccentColor: '#0E7490',
      placeholderAccentColor: '#67E8F9',
      maxTracks: ARP_MAX_TRACKS,
      estimatedGenerationMs: ESTIMATED_GENERATION_MS,
      addTrackLabel: 'Add Arp',
    },
    features: {
      instrumentPicker: true,
      bulkComposePlaceholders: false,
      exportMidi: true,
      transitionDesigner: false,
      importTracks: false,
    },
    createTrackOptions: () => ({ loadSynth: true, synthName: 'Surge XT' }),
    applyPortedTrackSound: async (handle: PluginTrackHandle) => {
      try {
        await host.shufflePreset(handle.id);
      } catch {
        /* non-fatal */
      }
    },
    // Every newborn track is anchored as a voice-group of ONE so the header
    // controls (voices / rate / split) are visible BEFORE the first generation.
    onTrackCreated: async (handle, ctx) => {
      await stampArpAnchor(host, ctx.activeSceneId, ctx.trackDataKey, handle.dbId);
    },
    // The core's generic path wants a system prompt; the real generation goes
    // through generateArp (schema-forced tools call), so this is only a sane
    // fallback shape.
    buildSystemPrompt: () =>
      buildArpSystemPrompt({
        voiceCount: DEFAULT_VOICE_COUNT,
        rate: DEFAULT_RATE,
        split: DEFAULT_SPLIT,
        bars: 4,
      }),
    parseNotesResponse: parseLLMNoteResponse,
    sound: surgeSound,
    shuffle: {
      shuffle: async (track, excludeNames) => {
        const result = await host.shufflePreset(track.handle.id, excludeNames);
        return { appliedName: result.presetName };
      },
      isExhaustedError: (err) =>
        /no presets available/i.test(err instanceof Error ? err.message : String(err)),
    },
    generation: { generate: generateArp },
    groupExtensions: [
      {
        ...arpVoiceGroupSpec,
        isComplete: arpGroupIsComplete,
        renderGroup: (group, ctx) => <ArpVoiceGroupRow group={group} ctx={ctx} />,
      },
    ],
  };
}

export function ArpGeneratorPanel(props: PluginUIProps): React.ReactElement {
  const adapter = useMemo(() => createArpGeneratorAdapter(props.host), [props.host]);
  const core = useGeneratorPanelCore({ ui: props, adapter: adapter as GeneratorPanelAdapter });
  return <GeneratorPanelShell core={core} />;
}

export default ArpGeneratorPanel;
