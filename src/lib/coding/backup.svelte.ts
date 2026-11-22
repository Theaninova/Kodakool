/**
 * Auto-backup preferences (issue: automatic backup downloads): after every
 * `every` newly coded entries the coding page downloads a fresh project backup;
 * 0 disables the feature. The per-project counter survives reloads.
 */
const EVERY_KEY = "luci-backup-every";
const COUNT_PREFIX = "luci-backup-count:";
export const BACKUP_DEFAULT = 50;

function num(key: string, fallback: number): number {
  const v = Number(localStorage.getItem(key));
  return Number.isInteger(v) && v >= 0 ? v : fallback;
}

export class BackupPrefs {
  /** newly coded entries between two automatic project backups; 0 = disabled */
  every = $state(num(EVERY_KEY, BACKUP_DEFAULT));

  setEvery(n: number): void {
    this.every = Number.isInteger(n) && n >= 0 ? n : BACKUP_DEFAULT;
    localStorage.setItem(EVERY_KEY, String(this.every));
  }
  count(folder: string): number {
    return num(COUNT_PREFIX + folder, 0);
  }
  /** one more coding in `folder`; returns the counter after the increment */
  bump(folder: string): number {
    const n = this.count(folder) + 1;
    localStorage.setItem(COUNT_PREFIX + folder, String(n));
    return n;
  }
  reset(folder: string): void {
    localStorage.setItem(COUNT_PREFIX + folder, "0");
  }
}
