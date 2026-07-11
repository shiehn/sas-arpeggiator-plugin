/**
 * arp-core — the mechanical heart of the arpeggiator, all pure functions.
 *
 * The LLM designs ONE repeating cell (`submit_arp` tool: chord-degree steps
 * with rests, octave offsets, and velocity accents). Everything after that is
 * deterministic: `expandPattern` tiles the cell over the scene's bars at the
 * chosen rate and re-roots every step on that bar's chord (chord tones only —
 * the output cannot leave the harmony), then `splitVoices` partitions the
 * stream across 1-4 voices either vertically (pitch bands — the "1" notes on
 * one patch, the "3-5-3" notes on another) or horizontally (alternating bars —
 * bar 1 on one patch, bar 2 on the next).
 */

// ============================================================================
// Domains
// ============================================================================

export const ARP_RATES = ['1/4', '1/8', '1/16'] as const;
export type ArpRate = (typeof ARP_RATES)[number];

/** Grid steps per quarter-note beat for each rate. */
export const STEPS_PER_BEAT: Readonly<Record<ArpRate, number>> = {
  '1/4': 1,
  '1/8': 2,
  '1/16': 4,
};

export const ARP_SPLITS = ['vertical', 'horizontal'] as const;
export type ArpSplit = (typeof ARP_SPLITS)[number];

export const ARP_MIN_VOICES = 1;
export const ARP_MAX_VOICES = 4;

/** The cell the LLM designs: 4-32 grid steps, tiled mechanically. */
export const ARP_PATTERN_MIN_STEPS = 4;
export const ARP_PATTERN_MAX_STEPS = 32;

/** Chord-degree indices: 0=root, 1=third, 2=fifth, 3=seventh (octave root on triads). */
export const ARP_TONE_MIN = 0;
export const ARP_TONE_MAX = 3;
export const ARP_OCTAVE_MIN = -1;
export const ARP_OCTAVE_MAX = 2;

/** Fraction of the grid step a note sounds — retriggers stay articulate. */
export const ARP_GATE = 0.9;

/** Home register: octave-0 roots fold to the octave around this MIDI pitch. */
export const ARP_HOME_PITCH = 60;

const PITCH_FLOOR = 24;
const PITCH_CEIL = 103;

// ============================================================================
// The submit_arp function-calling contract
// ============================================================================

export const SUBMIT_ARP_TOOL_NAME = 'submit_arp';

export interface ArpStep {
  /** Silent grid step (groove). */
  rest: boolean;
  /** Chord-degree index: 0=root, 1=third, 2=fifth, 3=seventh/octave-root. */
  tone: number;
  /** Octave offset from the home register (-1..2). */
  octave: number;
  /** 1-127. */
  velocity: number;
}

export interface ArpPattern {
  steps: ArpStep[];
  /** Structural oddities worth logging (clamped values, dropped steps…). */
  warnings: string[];
}

/**
 * JSON-Schema `parameters` for the submit_arp tool. Gemini function calling
 * accepts standard JSON Schema here (same convention as submit_ensemble).
 */
export function buildSubmitArpParameters(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        description:
          `The repeating arp cell as ${ARP_PATTERN_MIN_STEPS}-${ARP_PATTERN_MAX_STEPS} grid steps. ` +
          'The cell is tiled over the whole clip and re-rooted on each bar\'s chord mechanically — ' +
          'design contour, groove (rests), and accents (velocity), not absolute pitches.',
        items: {
          type: 'object',
          properties: {
            rest: { type: 'boolean', description: 'true = silent step (groove). Defaults to false.' },
            tone: {
              type: 'integer',
              description: 'Chord degree: 0=root, 1=third, 2=fifth, 3=seventh (octave root on plain triads).',
            },
            octave: { type: 'integer', description: `Octave offset ${ARP_OCTAVE_MIN}..${ARP_OCTAVE_MAX} from the home register.` },
            velocity: { type: 'integer', description: '1-127; use accents to shape the groove.' },
          },
          required: ['tone'],
        },
      },
    },
    required: ['steps'],
  };
}

const clampInt = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, Math.round(v)));

/**
 * Validate + normalize the functionCall args into an ArpPattern.
 * Returns null only when nothing usable came back (no steps, or all rests).
 */
export function parseArpArgs(args: unknown): ArpPattern | null {
  if (typeof args !== 'object' || args === null) return null;
  const stepsRaw = (args as { steps?: unknown }).steps;
  if (!Array.isArray(stepsRaw)) return null;

  const warnings: string[] = [];
  const steps: ArpStep[] = [];
  for (const s of stepsRaw) {
    if (steps.length >= ARP_PATTERN_MAX_STEPS) {
      warnings.push(`cell truncated to ${ARP_PATTERN_MAX_STEPS} steps`);
      break;
    }
    if (typeof s !== 'object' || s === null) {
      warnings.push('non-object step dropped');
      continue;
    }
    const step = s as { rest?: unknown; tone?: unknown; octave?: unknown; velocity?: unknown };
    const rest = step.rest === true;
    if (!rest && typeof step.tone !== 'number') {
      warnings.push('non-rest step without a tone dropped');
      continue;
    }
    steps.push({
      rest,
      tone: typeof step.tone === 'number' ? clampInt(step.tone, ARP_TONE_MIN, ARP_TONE_MAX) : 0,
      octave: typeof step.octave === 'number' ? clampInt(step.octave, ARP_OCTAVE_MIN, ARP_OCTAVE_MAX) : 0,
      velocity: typeof step.velocity === 'number' ? clampInt(step.velocity, 1, 127) : 96,
    });
  }

  if (steps.length === 0 || steps.every((s) => s.rest)) return null;
  return { steps, warnings };
}

// ============================================================================
// The joint prompt
// ============================================================================

export interface ArpPromptOptions {
  voiceCount: number;
  rate: ArpRate;
  split: ArpSplit;
  bars: number;
}

export function buildArpSystemPrompt(opts: ArpPromptOptions): string {
  const stepsPerBar = STEPS_PER_BEAT[opts.rate] * 4;
  const splitText =
    opts.voiceCount <= 1
      ? 'The cell plays as a single voice.'
      : opts.split === 'vertical'
        ? `The cell will be split VERTICALLY across ${opts.voiceCount} voices: higher-pitched steps land on one instrument, lower-pitched steps on another. Use octave offsets and tone choices to create distinct pitch bands.`
        : `The cell will be split HORIZONTALLY across ${opts.voiceCount} voices: whole bars alternate between instruments (bar 1 on voice 1, bar 2 on voice 2, …). Design a cell that stays interesting when its timbre changes each bar.`;

  return [
    'You are an arpeggiator pattern designer for a music production tool.',
    '',
    `Design ONE repeating arp cell on a ${opts.rate}-note grid (${stepsPerBar} steps per 4/4 bar).`,
    `Return it via the ${SUBMIT_ARP_TOOL_NAME} function ONLY — no prose.`,
    '',
    'The contract:',
    `- The cell is ${ARP_PATTERN_MIN_STEPS}-${ARP_PATTERN_MAX_STEPS} steps and is tiled mechanically over the whole clip (${opts.bars} bars).`,
    '- Each step is a CHORD DEGREE, not an absolute pitch: 0=root, 1=third, 2=fifth, 3=seventh (octave root on plain triads).',
    '- The machine re-roots every step on the chord sounding in its bar, so the pattern follows the progression automatically.',
    `- octave (${ARP_OCTAVE_MIN}..${ARP_OCTAVE_MAX}) shapes the contour; a classic 1-3-5-3 climb uses octave 0, a wide rave arp jumps to octave 1-2.`,
    '- rest:true steps are silence — use them for groove and syncopation instead of filling every step.',
    '- velocity (1-127) carries the accent pattern; flat velocities sound robotic.',
    '',
    splitText,
    '',
    'Match the requested character (speed feel, density, contour, mood). Prefer cell lengths that create interesting cycles against the bar (e.g. a 6-step cell on a 16-step bar rotates).',
  ].join('\n');
}

// ============================================================================
// Mechanical expansion — pattern × chords → notes
// ============================================================================

export interface ArpNote {
  pitch: number;
  startBeat: number;
  durationBeats: number;
  velocity: number;
  /** Bar index, kept for the horizontal split. */
  bar: number;
}

export interface ExpandOptions {
  bars: number;
  stepsPerBeat: number;
  /** Per-bar chord lookups (null = no chord info for that bar). */
  chordRootPcAtBar: (bar: number) => number | null;
  chordPcsAtBar: (bar: number) => Set<number> | null;
  /** Key scale pcs — picks minor vs major fallback thirds when a bar has no chord. */
  scalePcs?: Set<number>;
  /** Tonic pc used when a bar has no chord at all. Default 0 (C). */
  fallbackRootPc?: number;
  /** MIDI pitch the octave-0 root folds toward. Default ARP_HOME_PITCH. */
  homePitch?: number;
}

/** Nearest pitch with the given pitch class to `center` (ties resolve upward). */
function nearestPitchForPc(pc: number, center: number): number {
  let p = center + ((pc - (center % 12) + 12) % 12);
  if (p - center > 6) p -= 12;
  return p;
}

/**
 * Semitone offsets from the root for tone indices 0..3, derived from the
 * chord's actual pitch classes. Triads get an octave root as the "seventh".
 */
export function chordToneOffsets(rootPc: number, pcs: Set<number> | null, scalePcs?: Set<number>): number[] {
  if (pcs && pcs.size > 1) {
    const ivs = [...pcs]
      .map((pc) => (pc - rootPc + 12) % 12)
      .filter((iv) => iv > 0)
      .sort((a, b) => a - b);
    const third = ivs.find((iv) => iv >= 2 && iv <= 5) ?? 4;
    const fifth = ivs.find((iv) => iv >= 6 && iv <= 8) ?? 7;
    const seventh = ivs.find((iv) => iv >= 9 && iv <= 11) ?? 12;
    return [0, third, fifth, seventh];
  }
  // No chord info: diatonic-ish triad — minor third when the scale says so.
  const minorThird = scalePcs
    ? scalePcs.has((rootPc + 3) % 12) && !scalePcs.has((rootPc + 4) % 12)
    : false;
  return [0, minorThird ? 3 : 4, 7, 12];
}

/**
 * Tile the cell across the clip: step s → cell step (s mod cellLength),
 * re-rooted on the chord of the bar step s falls in. Pure and total — any
 * pattern in, in-harmony notes out.
 */
export function expandPattern(pattern: ArpPattern, opts: ExpandOptions): ArpNote[] {
  const beatsPerBar = 4;
  const home = opts.homePitch ?? ARP_HOME_PITCH;
  const stepDur = 1 / opts.stepsPerBeat;
  const totalSteps = opts.bars * beatsPerBar * opts.stepsPerBeat;
  const cell = pattern.steps;
  const notes: ArpNote[] = [];

  for (let s = 0; s < totalSteps; s++) {
    const step = cell[s % cell.length];
    if (step.rest) continue;
    const startBeat = s * stepDur;
    const bar = Math.floor(startBeat / beatsPerBar);
    const rootPc = opts.chordRootPcAtBar(bar) ?? opts.fallbackRootPc ?? 0;
    const offsets = chordToneOffsets(rootPc, opts.chordPcsAtBar(bar), opts.scalePcs);
    const rootPitch = nearestPitchForPc(rootPc, home);
    const pitch = Math.max(
      PITCH_FLOOR,
      Math.min(PITCH_CEIL, rootPitch + offsets[step.tone] + 12 * step.octave)
    );
    notes.push({
      pitch,
      startBeat,
      durationBeats: stepDur * ARP_GATE,
      velocity: step.velocity,
      bar,
    });
  }
  return notes;
}

// ============================================================================
// Voice splits
// ============================================================================

/**
 * Partition the expanded stream across `voiceCount` voices. Voice 0 is the
 * TOP band (vertical) or the FIRST bar rotation (horizontal), matching the
 * ensemble plugin's top-first convention. Voices may come back empty (e.g.
 * fewer distinct pitches than voices) — callers drop empties rather than
 * writing empty clips.
 */
export function splitVoices(
  notes: ArpNote[],
  voiceCount: number,
  split: ArpSplit
): ArpNote[][] {
  const n = Math.max(ARP_MIN_VOICES, Math.min(ARP_MAX_VOICES, Math.round(voiceCount)));
  if (n <= 1 || notes.length === 0) {
    const voices: ArpNote[][] = Array.from({ length: n }, () => []);
    voices[0] = [...notes];
    return voices;
  }

  const voices: ArpNote[][] = Array.from({ length: n }, () => []);

  if (split === 'horizontal') {
    for (const note of notes) {
      voices[note.bar % n].push(note);
    }
    return voices;
  }

  // Vertical: contiguous pitch bands, high → low, sized by note count so each
  // voice gets comparable activity. A pitch never straddles two voices.
  const countByPitch = new Map<number, number>();
  for (const note of notes) {
    countByPitch.set(note.pitch, (countByPitch.get(note.pitch) ?? 0) + 1);
  }
  const pitchesDesc = [...countByPitch.keys()].sort((a, b) => b - a);
  const total = notes.length;
  const bandOfPitch = new Map<number, number>();
  let cum = 0;
  for (const pitch of pitchesDesc) {
    bandOfPitch.set(pitch, Math.min(n - 1, Math.floor((cum * n) / total)));
    cum += countByPitch.get(pitch)!;
  }
  for (const note of notes) {
    voices[bandOfPitch.get(note.pitch)!].push(note);
  }
  return voices;
}

/** Mechanical row label for a voice ("top band", "even bars", …). */
export function voiceLabel(split: ArpSplit, index: number, voiceCount: number): string {
  if (voiceCount <= 1) return 'arp line';
  if (split === 'horizontal') {
    if (voiceCount === 2) return index === 0 ? 'odd bars' : 'even bars';
    return `bar ${index + 1} of every ${voiceCount}`;
  }
  const bands: Record<number, string[]> = {
    2: ['top band', 'bottom band'],
    3: ['top band', 'middle band', 'bottom band'],
    4: ['top band', 'upper band', 'lower band', 'bottom band'],
  };
  return bands[voiceCount]?.[index] ?? `band ${index + 1}`;
}
