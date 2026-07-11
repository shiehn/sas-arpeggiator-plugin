/**
 * arp-core — the pure mechanical layer: parse, prompt, expansion, splits.
 */

import {
  ARP_GATE,
  ARP_PATTERN_MAX_STEPS,
  buildArpSystemPrompt,
  buildSubmitArpParameters,
  chordToneOffsets,
  expandPattern,
  parseArpArgs,
  splitVoices,
  voiceLabel,
  type ArpNote,
  type ArpPattern,
} from '../arp-core';

const mkPattern = (steps: ArpPattern['steps']): ArpPattern => ({ steps, warnings: [] });
const t = (tone: number, octave = 0, velocity = 100): ArpPattern['steps'][number] => ({
  rest: false,
  tone,
  octave,
  velocity,
});
const rest = (): ArpPattern['steps'][number] => ({ rest: true, tone: 0, octave: 0, velocity: 96 });

/** C major on every bar. */
const C_MAJOR = {
  chordRootPcAtBar: () => 0,
  chordPcsAtBar: () => new Set([0, 4, 7]),
};

describe('buildSubmitArpParameters', () => {
  it('declares a steps array with tone required', () => {
    const params = buildSubmitArpParameters() as {
      properties: { steps: { items: { required: string[] } } };
      required: string[];
    };
    expect(params.required).toEqual(['steps']);
    expect(params.properties.steps.items.required).toEqual(['tone']);
  });
});

describe('parseArpArgs', () => {
  it('normalizes a clean cell', () => {
    const parsed = parseArpArgs({ steps: [{ tone: 0 }, { tone: 2, octave: 1, velocity: 80 }, { rest: true, tone: 0 }] });
    expect(parsed).not.toBeNull();
    expect(parsed!.steps).toEqual([
      { rest: false, tone: 0, octave: 0, velocity: 96 },
      { rest: false, tone: 2, octave: 1, velocity: 80 },
      { rest: true, tone: 0, octave: 0, velocity: 96 },
    ]);
    expect(parsed!.warnings).toEqual([]);
  });

  it('clamps tone, octave, and velocity into their domains', () => {
    const parsed = parseArpArgs({ steps: [{ tone: 9, octave: 5, velocity: 300 }, { tone: -2, octave: -4, velocity: 0 }] });
    expect(parsed!.steps[0]).toEqual({ rest: false, tone: 3, octave: 2, velocity: 127 });
    expect(parsed!.steps[1]).toEqual({ rest: false, tone: 0, octave: -1, velocity: 1 });
  });

  it('drops malformed steps with warnings but keeps the usable ones', () => {
    const parsed = parseArpArgs({ steps: ['nope', { velocity: 90 }, { tone: 1 }] });
    expect(parsed!.steps).toHaveLength(1);
    expect(parsed!.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('truncates cells beyond the max step count', () => {
    const parsed = parseArpArgs({ steps: Array.from({ length: 50 }, () => ({ tone: 0 })) });
    expect(parsed!.steps).toHaveLength(ARP_PATTERN_MAX_STEPS);
    expect(parsed!.warnings.some((w) => /truncated/.test(w))).toBe(true);
  });

  it('returns null for garbage, empty, and all-rest cells', () => {
    expect(parseArpArgs(null)).toBeNull();
    expect(parseArpArgs({})).toBeNull();
    expect(parseArpArgs({ steps: [] })).toBeNull();
    expect(parseArpArgs({ steps: [{ rest: true, tone: 0 }] })).toBeNull();
  });
});

describe('buildArpSystemPrompt', () => {
  it('states grid, tool name, and the split contract', () => {
    const vertical = buildArpSystemPrompt({ voiceCount: 3, rate: '1/16', split: 'vertical', bars: 4 });
    expect(vertical).toContain('1/16-note grid (16 steps per 4/4 bar)');
    expect(vertical).toContain('submit_arp');
    expect(vertical).toContain('split VERTICALLY across 3 voices');

    const horizontal = buildArpSystemPrompt({ voiceCount: 2, rate: '1/8', split: 'horizontal', bars: 4 });
    expect(horizontal).toContain('1/8-note grid (8 steps per 4/4 bar)');
    expect(horizontal).toContain('split HORIZONTALLY across 2 voices');

    const solo = buildArpSystemPrompt({ voiceCount: 1, rate: '1/4', split: 'vertical', bars: 2 });
    expect(solo).toContain('single voice');
  });
});

describe('chordToneOffsets', () => {
  it('derives third/fifth/seventh from the chord pcs', () => {
    expect(chordToneOffsets(9, new Set([9, 0, 4]))).toEqual([0, 3, 7, 12]); // Am → octave root
    expect(chordToneOffsets(0, new Set([0, 4, 7, 11]))).toEqual([0, 4, 7, 11]); // Cmaj7
    expect(chordToneOffsets(0, new Set([0, 4, 7, 10]))).toEqual([0, 4, 7, 10]); // C7
    expect(chordToneOffsets(0, new Set([0, 5, 7]))).toEqual([0, 5, 7, 12]); // Csus4
  });

  it('falls back to a scale-aware triad when the bar has no chord', () => {
    const aMinorScale = new Set([9, 11, 0, 2, 4, 5, 7]);
    expect(chordToneOffsets(9, null, aMinorScale)).toEqual([0, 3, 7, 12]); // minor third
    expect(chordToneOffsets(0, null, aMinorScale)).toEqual([0, 4, 7, 12]); // C gets a major third
    expect(chordToneOffsets(0, null, undefined)).toEqual([0, 4, 7, 12]);
  });
});

describe('expandPattern', () => {
  it('tiles the cell across the clip on the grid with gated durations', () => {
    const notes = expandPattern(mkPattern([t(0), t(1)]), {
      bars: 1,
      stepsPerBeat: 2, // 1/8
      ...C_MAJOR,
    });
    expect(notes).toHaveLength(8);
    expect(notes.map((n) => n.startBeat)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
    expect(notes.map((n) => n.pitch)).toEqual([60, 64, 60, 64, 60, 64, 60, 64]);
    expect(notes[0].durationBeats).toBeCloseTo(0.5 * ARP_GATE);
  });

  it('re-roots each bar on that bar\'s chord', () => {
    const notes = expandPattern(mkPattern([t(0)]), {
      bars: 2,
      stepsPerBeat: 1, // 1/4
      chordRootPcAtBar: (bar) => (bar === 0 ? 0 : 9), // C then Am
      chordPcsAtBar: (bar) => (bar === 0 ? new Set([0, 4, 7]) : new Set([9, 0, 4])),
    });
    expect(notes.map((n) => n.pitch)).toEqual([60, 60, 60, 60, 57, 57, 57, 57]);
    expect(notes.map((n) => n.bar)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
  });

  it('skips rest steps', () => {
    const notes = expandPattern(mkPattern([t(0), rest()]), {
      bars: 1,
      stepsPerBeat: 4, // 1/16
      ...C_MAJOR,
    });
    expect(notes).toHaveLength(8);
    expect(notes.every((n, i) => n.startBeat === i * 0.5)).toBe(true);
  });

  it('applies octave offsets and uses the fallback root when no chords exist', () => {
    const notes = expandPattern(mkPattern([t(0, 1), t(1, -1)]), {
      bars: 1,
      stepsPerBeat: 1,
      chordRootPcAtBar: () => null,
      chordPcsAtBar: () => null,
      scalePcs: new Set([9, 11, 0, 2, 4, 5, 7]),
      fallbackRootPc: 9, // A minor tonic
    });
    // Root folds to 57; +12 → 69; minor third −12 → 48.
    expect(notes.map((n) => n.pitch)).toEqual([69, 48, 69, 48]);
  });
});

describe('splitVoices', () => {
  const note = (pitch: number, startBeat: number, bar = 0): ArpNote => ({
    pitch,
    startBeat,
    durationBeats: 0.25,
    velocity: 100,
    bar,
  });

  it('vertical: the 1-3-5-3-1 example — roots on one voice, 3-5-3 on the other', () => {
    const stream = [note(60, 0), note(64, 1), note(67, 2), note(64, 3), note(60, 4)];
    const [top, bottom] = splitVoices(stream, 2, 'vertical');
    expect(top.map((n) => n.pitch)).toEqual([64, 67, 64]);
    expect(bottom.map((n) => n.pitch)).toEqual([60, 60]);
  });

  it('vertical: a pitch never straddles two voices and empty bands stay empty', () => {
    const stream = [note(60, 0), note(60, 1), note(60, 2)];
    const voices = splitVoices(stream, 3, 'vertical');
    expect(voices[0]).toHaveLength(3);
    expect(voices[1]).toHaveLength(0);
    expect(voices[2]).toHaveLength(0);
  });

  it('horizontal: bars rotate round-robin across voices', () => {
    const stream = [note(60, 0, 0), note(60, 4, 1), note(60, 8, 2), note(60, 12, 3)];
    const [a, b] = splitVoices(stream, 2, 'horizontal');
    expect(a.map((n) => n.bar)).toEqual([0, 2]);
    expect(b.map((n) => n.bar)).toEqual([1, 3]);
  });

  it('voiceCount 1 keeps the whole stream on voice 0', () => {
    const stream = [note(60, 0), note(72, 1)];
    const voices = splitVoices(stream, 1, 'vertical');
    expect(voices).toHaveLength(1);
    expect(voices[0]).toHaveLength(2);
  });
});

describe('voiceLabel', () => {
  it('names vertical bands top-first and horizontal rotations by bar', () => {
    expect(voiceLabel('vertical', 0, 1)).toBe('arp line');
    expect(voiceLabel('vertical', 0, 2)).toBe('top band');
    expect(voiceLabel('vertical', 1, 2)).toBe('bottom band');
    expect(voiceLabel('vertical', 1, 4)).toBe('upper band');
    expect(voiceLabel('horizontal', 0, 2)).toBe('odd bars');
    expect(voiceLabel('horizontal', 1, 2)).toBe('even bars');
    expect(voiceLabel('horizontal', 2, 3)).toBe('bar 3 of every 3');
  });
});
