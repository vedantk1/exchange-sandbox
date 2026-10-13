export function amount(value: string): string {
  const [whole = '0', fraction] = value.split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction === undefined ? '' : `.${fraction}`}`;
}

export function label(value: string): string {
  return value.toLowerCase().replaceAll('_', ' ');
}

export function date(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function addExact(a: string, b: string, scale: number): string {
  const toUnits = (value: string): bigint => {
    const [whole = '0', fraction = ''] = value.split('.');
    return BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0'));
  };
  const total = toUnits(a) + toUnits(b);
  const unit = 10n ** BigInt(scale);
  return `${total / unit}.${(total % unit).toString().padStart(scale, '0')}`;
}

export function validGrant(value: string, asset: string): boolean {
  const scale = asset === 'BTC-SIM' ? 4 : 9;
  if (!new RegExp(`^(0|[1-9][0-9]*)(\\.[0-9]{1,${scale}})?$`).test(value)) return false;
  if (value.length > 64) return false;
  const [whole = '0', fraction = ''] = value.split('.');
  const units = BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0'));
  const limit = BigInt(asset === 'BTC-SIM' ? 100 : 10_000_000) * 10n ** BigInt(scale);
  return units > 0n && units <= limit;
}
