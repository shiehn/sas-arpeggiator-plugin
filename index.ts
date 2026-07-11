/**
 * @signalsandsorcery/arp-generator — plugin entry.
 *
 * Multi-voice arpeggiator: one prompt → the LLM designs ONE repeating arp
 * cell (chord-degree steps, rests, accents, octave contour) via a single
 * schema-forced call → the mechanical expander tiles the cell over the
 * scene's per-bar chords at the chosen rate (1/4, 1/8, 1/16) — always chord
 * tones, never off-key — then splits it vertically (pitch bands) or
 * horizontally (alternating bars) across 1-4 voices, each on its own
 * Surge XT track. See ArpGeneratorPanel.tsx and src/arp-generation.ts.
 */

import type { ComponentType } from 'react';
import type {
  GeneratorPlugin,
  PluginHost,
  PluginUIProps,
  PluginSettingsSchema,
} from '@signalsandsorcery/plugin-sdk';
import { ArpGeneratorPanel } from './ArpGeneratorPanel';
import manifest from './plugin.json';

class ArpGeneratorPlugin implements GeneratorPlugin {
  readonly id = '@signalsandsorcery/arp-generator';
  readonly displayName = 'Arpeggiator';
  readonly version = '1.0.0';
  readonly description =
    'Multi-voice arpeggiator — one prompt becomes a repeating arp cell tiled over the scene\'s per-bar chords at 1/4, 1/8, or 1/16, split vertically (pitch bands) or horizontally (alternating bars) across 1-4 voices, each on its own Surge XT track';
  readonly generatorType = 'midi' as const;
  readonly minHostVersion = '1.0.0';

  private host: PluginHost | null = null;

  async activate(host: PluginHost): Promise<void> {
    this.host = host;
    console.log('[ArpGeneratorPlugin] activated');
  }

  async deactivate(): Promise<void> {
    this.host = null;
  }

  getUIComponent(): ComponentType<PluginUIProps> {
    return ArpGeneratorPanel;
  }

  getSettingsSchema(): PluginSettingsSchema | null {
    return null;
  }
}

export default ArpGeneratorPlugin;
export { ArpGeneratorPlugin, ArpGeneratorPanel };
export const arpManifest = manifest;
