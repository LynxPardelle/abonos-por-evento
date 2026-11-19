import { decimalToMinor, formatMinor } from './money';

describe('money at the UI boundary', () => {
  it('converts a decimal without binary floating point rounding', () => {
    expect(decimalToMinor('1000.01')).toBe('100001');
    expect(decimalToMinor('0.10')).toBe('10');
  });
  it('rejects an ambiguous or nonpositive amount', () => {
    for (const value of ['1,000.00', '0', '-1', '1.001', '1e3', '']) {
      expect(() => decimalToMinor(value)).toThrow();
    }
  });
  it('formats arbitrarily large minor units without precision loss', () => {
    expect(formatMinor('900719925474099301', 'MXN')).toContain('9,007,199,254,740,993.01');
    expect(formatMinor('-125', 'MXN')).toContain('-1.25');
  });
});
