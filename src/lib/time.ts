/**
 * Calendar math in the *caller's* time zone. Clients send their
 * `Date.prototype.getTimezoneOffset()` (minutes; IST = -330) so "today" and
 * week boundaries match what the user sees.
 */
export const DAY_MS = 86_400_000

export class LocalClock {
  constructor(
    readonly now: number,
    /** `getTimezoneOffset()` of the client. */
    readonly tzOffsetMinutes: number,
  ) {}

  private toLocal(ms: number) {
    return ms - this.tzOffsetMinutes * 60_000
  }

  private fromLocal(ms: number) {
    return ms + this.tzOffsetMinutes * 60_000
  }

  /** UTC ms of local midnight on the day containing `ms`. */
  startOfDay(ms: number): number {
    const local = this.toLocal(ms)
    return this.fromLocal(local - (((local % DAY_MS) + DAY_MS) % DAY_MS))
  }

  /** UTC ms of local Monday 00:00 of the week containing `ms`. */
  startOfWeek(ms: number): number {
    const day = this.startOfDay(ms)
    const weekday = new Date(this.toLocal(day)).getUTCDay() // 0 = Sunday
    return day - ((weekday + 6) % 7) * DAY_MS
  }

  /** Local calendar date `YYYY-MM-DD` for `ms`. */
  dateKey(ms: number): string {
    return new Date(this.toLocal(ms)).toISOString().slice(0, 10)
  }

  isToday(iso: string | undefined): boolean {
    return !!iso && this.startOfDay(Date.parse(iso)) === this.startOfDay(this.now)
  }

  /** Before today (time of day ignored). */
  isOverdue(iso: string | undefined): boolean {
    return !!iso && this.startOfDay(Date.parse(iso)) < this.startOfDay(this.now)
  }

  /** From the start of today up to `days` from now. */
  isWithinDays(iso: string | undefined, days: number): boolean {
    if (!iso) return false
    const t = Date.parse(iso)
    return t >= this.startOfDay(this.now) && t <= this.now + days * DAY_MS
  }
}
