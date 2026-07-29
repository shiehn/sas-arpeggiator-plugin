/**
 * expandPattern + chordLookupsFromTiming under non-4/4 meters (P8b): bar
 * re-rooting on bars×qn boundaries, the fractional 1/4-rate /8-meter grid
 * (continuous, barline-crossing, end-clamped), and the horizontal split's
 * bar-indexed rotation. Legacy 4/4 behavior is covered by arp-core.test.ts,
 * which runs unmodified (omitted `quarterNotesPerBar` = the 4/4 grid).
 */
import {
  expandPattern,
  splitVoices,
  type ArpPattern,
} from '../arp-core';
import { chordLookupsFromTiming } from '../music-helpers';

/** Cell of one root-tone step per grid step (no rests) at velocity 96. */
const rootCell = (steps: number): ArpPattern => ({
  steps: Array.from({ length: steps }, () => ({ rest: false, tone: 0, octave: 0, velocity: 96 })),
  warnings: [],
});

const AM_F_3_4 = chordLookupsFromTiming(
  [
    { symbol: 'Am', startQn: 0, endQn: 3 },
    { symbol: 'F', startQn: 3, endQn: 6 },
  ],
  '3/4'
);

describe('expandPattern — meter-aware bar re-rooting', () => {
  it('3/4 at 1/8: re-roots at the 3-qn barline (a 4/4 grid would flip at qn 4)', () => {
    const notes = expandPattern(rootCell(6), {
      bars: 2,
      stepsPerBeat: 2,
      chordRootPcAtBar: AM_F_3_4.chordRootPcAtBar,
      chordPcsAtBar: AM_F_3_4.chordPcsAtBar,
      quarterNotesPerBar: 3,
    });
    expect(notes).toHaveLength(12); // 2 bars × 3 qn × 2 steps/qn
    const bar0 = notes.filter((n) => n.bar === 0);
    const bar1 = notes.filter((n) => n.bar === 1);
    expect(bar0.map((n) => n.startBeat)).toEqual([0, 0.5, 1, 1.5, 2, 2.5]);
    expect(bar1[0].startBeat).toBe(3); // barline at 3 qn, not 4
    expect(bar0.every((n) => n.pitch % 12 === 9)).toBe(true); // Am roots
    expect(bar1.every((n) => n.pitch % 12 === 5)).toBe(true); // F roots
  });

  it('7/8 at 1/16: 28 exact steps over 2 bars; the 3.5-qn boundary attributes exactly', () => {
    const notes = expandPattern(rootCell(4), {
      bars: 2,
      stepsPerBeat: 4,
      chordRootPcAtBar: () => 0,
      chordPcsAtBar: () => null,
      quarterNotesPerBar: 3.5,
    });
    expect(notes).toHaveLength(28); // 2 × 3.5 × 4 — integral
    const boundary = notes.find((n) => n.startBeat === 3.5);
    expect(boundary?.bar).toBe(1); // exact, no FP drift
    expect(notes.filter((n) => n.bar === 0)).toHaveLength(14);
    const last = notes[notes.length - 1];
    expect(last.startBeat).toBe(6.75);
    expect(last.startBeat + last.durationBeats).toBeLessThanOrEqual(7);
  });

  it('5/8 at 1/4 (fractional steps-per-bar): continuous grid crosses barlines, even bars stay integral', () => {
    const notes = expandPattern(rootCell(5), {
      bars: 2,
      stepsPerBeat: 1,
      chordRootPcAtBar: () => 0,
      chordPcsAtBar: () => null,
      quarterNotesPerBar: 2.5,
    });
    // 2 × 2.5 × 1 = 5 whole steps at every quarter note.
    expect(notes.map((n) => [n.startBeat, n.bar])).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 1], // bar 2 starts at 2.5 — this step is INSIDE bar 2
      [4, 1],
    ]);
  });

  it('5/8 at 1/4 with an odd bar count: the rounded final step is clamped to the clip end', () => {
    const notes = expandPattern(rootCell(3), {
      bars: 1, // hand-called case — scene bars are even in production
      stepsPerBeat: 1,
      chordRootPcAtBar: () => 0,
      chordPcsAtBar: () => null,
      quarterNotesPerBar: 2.5,
    });
    // round(2.5) = 3 steps; the last starts at 2 and must end at the 2.5-qn clip.
    expect(notes).toHaveLength(3);
    expect(notes[2].startBeat).toBe(2);
    expect(notes[2].durationBeats).toBe(0.5);
  });

  it('invalid quarterNotesPerBar degrades to the 4/4 grid', () => {
    const notes = expandPattern(rootCell(4), {
      bars: 1,
      stepsPerBeat: 1,
      chordRootPcAtBar: () => 0,
      chordPcsAtBar: () => null,
      quarterNotesPerBar: NaN,
    });
    expect(notes).toHaveLength(4);
    expect(notes.every((n) => n.bar === 0)).toBe(true);
  });
});

describe('splitVoices — horizontal rotation stays bar-indexed across meters', () => {
  it('6/8: odd/even 3-qn bars alternate voices', () => {
    const notes = expandPattern(rootCell(3), {
      bars: 4,
      stepsPerBeat: 1,
      chordRootPcAtBar: () => 0,
      chordPcsAtBar: () => null,
      quarterNotesPerBar: 3,
    });
    const [v0, v1] = splitVoices(notes, 2, 'horizontal');
    expect(v0.every((n) => n.bar % 2 === 0)).toBe(true);
    expect(v1.every((n) => n.bar % 2 === 1)).toBe(true);
    expect(v0.length + v1.length).toBe(notes.length);
    // Voice 1's first note starts at the 6/8 barline (3 qn).
    expect(v1[0].startBeat).toBe(3);
  });
});

describe('chordLookupsFromTiming — meter windows', () => {
  it("'6/8' maps bar N to the 3-qn window; omitted keeps the legacy 4-qn grid", () => {
    const timing = [
      { symbol: 'C', startQn: 0, endQn: 3 },
      { symbol: 'G', startQn: 3, endQn: 6 },
    ];
    const metered = chordLookupsFromTiming(timing, '6/8');
    expect(metered.chordRootPcAtBar(0)).toBe(0);
    expect(metered.chordRootPcAtBar(1)).toBe(7);
    const legacy = chordLookupsFromTiming(timing);
    // Legacy bar 1 starts at qn 4 — inside the G region [3, 6).
    expect(legacy.chordRootPcAtBar(1)).toBe(7);
  });
});
