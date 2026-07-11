import { chordLookupsFromTiming, parseChordSymbol, scalePcsFor } from '../music-helpers';

describe('parseChordSymbol', () => {
  it('parses common symbols to root pc + chord pcs', () => {
    expect(parseChordSymbol('C')).toEqual({ rootPc: 0, pcs: new Set([0, 4, 7]) });
    expect(parseChordSymbol('F#m7')).toEqual({ rootPc: 6, pcs: new Set([6, 9, 1, 4]) });
    expect(parseChordSymbol('Bb7')).toEqual({ rootPc: 10, pcs: new Set([10, 2, 5, 8]) });
    expect(parseChordSymbol('Am')).toEqual({ rootPc: 9, pcs: new Set([9, 0, 4]) });
  });

  it('degrades unknown qualities to root+fifth and rejects garbage', () => {
    const weird = parseChordSymbol('Calt13#9');
    expect(weird?.rootPc).toBe(0);
    expect(weird?.pcs).toEqual(new Set([0, 7]));
    expect(parseChordSymbol('??')).toBeNull();
  });
});

describe('scalePcsFor', () => {
  it('builds F# natural minor', () => {
    expect(scalePcsFor('F#', 'minor')).toEqual(new Set([6, 8, 9, 11, 1, 2, 4]));
  });
  it('returns null for unknown keys/modes', () => {
    expect(scalePcsFor('H', 'minor')).toBeNull();
    expect(scalePcsFor('C', 'klingon')).toBeNull();
  });
});

describe('chordLookupsFromTiming', () => {
  const { chordRootPcAtBar, chordPcsAtBar } = chordLookupsFromTiming([
    { symbol: 'Am', startQn: 0, endQn: 4 },
    { symbol: 'F', startQn: 4, endQn: 8 },
  ]);

  it('resolves the chord sounding at each bar', () => {
    expect(chordRootPcAtBar(0)).toBe(9);
    expect(chordRootPcAtBar(1)).toBe(5);
    expect(chordPcsAtBar(1)).toEqual(new Set([5, 9, 0]));
  });

  it('returns null beyond the progression', () => {
    expect(chordRootPcAtBar(7)).toBeNull();
  });
});
