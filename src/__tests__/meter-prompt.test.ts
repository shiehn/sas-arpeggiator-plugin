/**
 * Meter-awareness of the arp system prompt (P8b multi-time-signature).
 *
 * BYTE-IDENTITY PIN: the snapshots below were recorded from the PRE-meter
 * implementation (`buildArpSystemPrompt` with no meter option). After the
 * meter option landed, the 4/4 prompt — with the option omitted OR passed
 * explicitly as '4/4' — must still match these snapshots byte-for-byte.
 * Never `--ci`-update these snapshots as part of a meter change; a diff
 * here means 4/4 behavior drifted. Last deliberately revised for the
 * hat-grid interlock line (2026-07-30, hand-edited snap).
 */
import { buildArpSystemPrompt } from '../arp-core';

describe('buildArpSystemPrompt — 4/4 byte identity', () => {
  it('1/16 vertical 3 voices (snapshot pin)', () => {
    expect(
      buildArpSystemPrompt({ voiceCount: 3, rate: '1/16', split: 'vertical', bars: 4 })
    ).toMatchSnapshot();
  });

  it('1/8 horizontal 2 voices (snapshot pin)', () => {
    expect(
      buildArpSystemPrompt({ voiceCount: 2, rate: '1/8', split: 'horizontal', bars: 8 })
    ).toMatchSnapshot();
  });

  it('1/4 single voice (snapshot pin)', () => {
    expect(
      buildArpSystemPrompt({ voiceCount: 1, rate: '1/4', split: 'vertical', bars: 2 })
    ).toMatchSnapshot();
  });

  it("omitted, explicit '4/4', and unparseable meters all produce the identical legacy prompt", () => {
    const base = { voiceCount: 3, rate: '1/16', split: 'vertical', bars: 4 } as const;
    const legacy = buildArpSystemPrompt(base);
    expect(buildArpSystemPrompt({ ...base, timeSignature: '4/4' })).toBe(legacy);
    expect(buildArpSystemPrompt({ ...base, timeSignature: 'waltz' })).toBe(legacy);
    expect(buildArpSystemPrompt({ ...base, timeSignature: '' })).toBe(legacy);
  });
});

describe('buildArpSystemPrompt — non-4/4 meters', () => {
  it('6/8 at 1/16: integer steps-per-bar named for the real meter + appended rules', () => {
    const prompt = buildArpSystemPrompt({
      voiceCount: 2, rate: '1/16', split: 'vertical', bars: 4, timeSignature: '6/8',
    });
    expect(prompt).toContain('(12 steps per bar of 6/8)'); // 3 qn × 4 steps/qn
    expect(prompt).not.toContain('per 4/4 bar');
    expect(prompt).toContain('Time signature 6/8 — meter rules:');
    expect(prompt).toContain('SECOND pulse');
    // 12-step bar: 6 divides it evenly, so the example cell is 5 steps.
    expect(prompt).toContain('a 5-step cell on a 12-step bar rotates');
  });

  it('7/8 at 1/16: the fractional bar still yields the integer 14-step figure', () => {
    const prompt = buildArpSystemPrompt({
      voiceCount: 1, rate: '1/16', split: 'vertical', bars: 2, timeSignature: '7/8',
    });
    expect(prompt).toContain('(14 steps per bar of 7/8)'); // 3.5 qn × 4
    expect(prompt).toContain('2+2+3');
  });

  it('5/8 at 1/4 (the only fractional rate×meter family): honest 2-bar phrasing', () => {
    const prompt = buildArpSystemPrompt({
      voiceCount: 1, rate: '1/4', split: 'vertical', bars: 4, timeSignature: '5/8',
    });
    // 2.5 steps/bar → the prompt speaks in the 5-step 2-bar cycle instead.
    expect(prompt).toContain('5 steps per 2 bars of 5/8');
    expect(prompt).toContain('crosses barlines');
    expect(prompt).not.toContain('2.5 steps per bar');
  });

  it('12/8 at 1/8: the cycle example avoids a cell length that divides the bar', () => {
    const prompt = buildArpSystemPrompt({
      voiceCount: 1, rate: '1/8', split: 'vertical', bars: 4, timeSignature: '12/8',
    });
    // 12-step bar: a 6-step cell would divide evenly — the example uses 5.
    expect(prompt).toContain('a 5-step cell on a 12-step bar rotates');
  });

  it('3/4: waltz rules appended, accent clarifier present', () => {
    const prompt = buildArpSystemPrompt({
      voiceCount: 2, rate: '1/8', split: 'horizontal', bars: 4, timeSignature: '3/4',
    });
    expect(prompt).toContain('(6 steps per bar of 3/4)');
    expect(prompt).toContain('NO beats-2-and-4 backbeat');
    expect(prompt).toContain("THIS meter's group starts");
  });
});
