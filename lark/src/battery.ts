export interface TransmitterBattery { slot: number; connected: boolean; percent: number | null }
export function batteryFromStatus(report: unknown): TransmitterBattery[] {
  if (!Array.isArray(report) || report.length !== 64 || report.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) return [];
  if ([0x55, 0xbb, 0xdd, 0x10, 0x80].some((byte, i) => report[i] !== byte)) return [];
  const length = report[5] * 256 + report[6];
  if (length < 4 || length > 56 || report[7] > 1 || report[8] > 1 || report[9] > 100 || report[10] > 100) return [];
  return [0, 1].map(i => ({slot:i+1, connected:report[7+i] === 1, percent:report[7+i] === 1 ? report[9+i] : null}));
}
