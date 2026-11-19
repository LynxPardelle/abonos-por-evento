export function decimalToMinor(value: string): string {
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(value)) throw new Error('Usa un importe como 1250.00, sin separadores de miles.');
  const [whole, decimal = ''] = value.split('.');
  const minor = BigInt(whole) * 100n + BigInt(decimal.padEnd(2, '0'));
  if (minor <= 0n) throw new Error('El importe debe ser mayor que cero.');
  return minor.toString();
}

export function formatMinor(value: string, currency = 'MXN'): string {
  if (!/^-?\d+$/.test(value)) return '—';
  const amount = BigInt(value);
  const positive = amount < 0n ? -amount : amount;
  return `${amount < 0n ? '-' : ''}${(positive / 100n).toLocaleString('en-US')}.${(positive % 100n).toString().padStart(2, '0')} ${currency}`;
}
