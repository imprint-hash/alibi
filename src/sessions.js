// Trading-session maths. Pure functions.
// 1) Pyth publishes an exact open/closed schedule per feed ("Europe/London;Mon,...,Sun;MMDD/ranges,...").
// 2) Alibi adds an explicit liquidity table (our heuristic, labelled as such) for "thin hours" inside open sessions.

const DAY_MS = 86400000;

/** Wall-clock parts of a UTC timestamp (ms) in a time zone. */
export function zonedParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const wd = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[p.weekday];
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, ss: +p.second, wd };
}

/** UTC ms for a wall-clock time in a zone (handles DST by iterating on the offset). */
export function zonedToUtc(y, m, d, hh, mm, tz) {
  let guess = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(guess, tz);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
    const diff = asUtc - Date.UTC(y, m - 1, d, hh, mm);
    if (diff === 0) break;
    guess -= diff;
  }
  return guess;
}

const parseRanges = (s) => {
  if (s === 'C') return [];
  if (s === 'O') return [[0, 1440]];
  return s.split('&').map((r) => {
    const [a, b] = r.split('-');
    return [+a.slice(0, 2) * 60 + +a.slice(2), +b.slice(0, 2) * 60 + +b.slice(2)];
  });
};

/** Parses a Pyth schedule string. */
export function parseSchedule(str) {
  const [tz, days, hol = ''] = String(str).split(';');
  const weekly = days.split(',').map(parseRanges);
  if (weekly.length !== 7) throw new Error('bad schedule: need 7 day entries');
  const holidays = {};
  for (const h of hol.split(',').filter(Boolean)) {
    const [md, r] = h.split('/');
    holidays[md] = parseRanges(r);
  }
  return { tz, weekly, holidays, raw: str };
}

/** Open ranges (minutes of local day) for a local calendar date. */
export function rangesForLocalDate(sched, y, m, d) {
  const md = String(m).padStart(2, '0') + String(d).padStart(2, '0');
  if (sched.holidays[md]) return sched.holidays[md];
  const wd = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Mon=0
  return sched.weekly[wd];
}

export function isOpen(sched, ms) {
  const p = zonedParts(ms, sched.tz);
  const min = p.hh * 60 + p.mm;
  return rangesForLocalDate(sched, p.y, p.m, p.d).some(([a, b]) => min >= a && min < b);
}

const addDays = (y, m, d, n) => { const t = new Date(Date.UTC(y, m - 1, d) + n * DAY_MS); return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()]; };

/**
 * The trading session for business day `dateStr` (YYYY-MM-DD, local to the schedule zone):
 * the contiguous open block that ends with that day's last close, merged back across midnight.
 * Returns { open, close } in UTC ms, or null if the day is closed.
 */
export function sessionForDay(sched, dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const r = rangesForLocalDate(sched, y, m, d);
  if (!r.length) return null;
  const dayStart = zonedToUtc(y, m, d, 0, 0, sched.tz);
  // The session that belongs to this day closes at the last range ending before midnight.
  // A range that runs to 24:00 belongs to the NEXT day's session (e.g. Sunday 18:00 ET opens Monday for metals).
  let ci = -1;
  for (let k = r.length - 1; k >= 0; k--) if (r[k][1] < 1440) { ci = k; break; }
  if (ci < 0) {
    // Open all day with no close (FX Mon–Thu): treat the calendar day in the schedule zone as the session.
    const full = r.length === 1 && r[0][0] === 0 && r[0][1] === 1440;
    return full ? { open: dayStart, close: zonedToUtc(...addDays(y, m, d, 1), 0, 0, sched.tz), continuous: true } : null;
  }
  const close = dayStart + r[ci][1] * 60000;
  let i = ci;
  while (i > 0 && r[i - 1][1] === r[i][0]) i--;
  let open = dayStart + r[i][0] * 60000;
  let [py, pm, pd] = [y, m, d];
  let startsAtMidnight = r[i][0] === 0;
  for (let k = 0; k < 3 && startsAtMidnight; k++) {
    [py, pm, pd] = addDays(py, pm, pd, -1);
    const pr = rangesForLocalDate(sched, py, pm, pd);
    if (!pr.length || pr[pr.length - 1][1] !== 1440) break;
    if (pr.length === 1 && pr[0][0] === 0) break; // previous day open around the clock (FX): don't merge further back
    let j = pr.length - 1;
    while (j > 0 && pr[j - 1][1] === pr[j][0]) j--;
    open = zonedToUtc(py, pm, pd, 0, 0, sched.tz) + pr[j][0] * 60000;
    startsAtMidnight = pr[j][0] === 0 && j === 0;
  }
  return { open, close };
}

/** Business days (YYYY-MM-DD) between two dates inclusive that have a session. */
export function tradingDays(sched, fromStr, toStr) {
  const out = [];
  let [y, m, d] = fromStr.split('-').map(Number);
  const end = toStr;
  for (let i = 0; i < 400; i++) {
    const s = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (s > end) break;
    if (sessionForDay(sched, s)) out.push(s);
    [y, m, d] = addDays(y, m, d, 1);
  }
  return out;
}

/**
 * Alibi's explicit liquidity table (heuristic, not from Pyth).
 * Times are America/New_York. "core" = when the primary price discovery happens.
 * WTI: NYMEX/ICE settlement window is 14:28–14:30 ET; after it, trading thins until the 18:00 ET halt.
 */
export const LIQUIDITY = {
  WTI: { tz: 'America/New_York', core: [[8 * 60, 14 * 60 + 30]], note: 'core 08:00–14:30 ET (up to settlement); 14:30–18:00 ET post-settlement and overnight hours are thin' },
  BRENT: { tz: 'America/New_York', core: [[3 * 60, 14 * 60 + 30]], note: 'core 03:00–14:30 ET (London + NY overlap); later hours thin' },
  XAU: { tz: 'America/New_York', core: [[3 * 60, 13 * 60 + 30]], note: 'core 03:00–13:30 ET (London open to COMEX close); 13:30–17:00 ET and the Asian session are thin' },
  XAG: { tz: 'America/New_York', core: [[3 * 60, 13 * 60 + 25]], note: 'core 03:00–13:25 ET (London open to COMEX close); later NY afternoon and Asian hours are thin' },
  EURUSD: { tz: 'America/New_York', core: [[3 * 60, 12 * 60]], note: 'core 03:00–12:00 ET (London + NY overlap); NY afternoon and Asian hours thinner' },
};

/** 'closed' | 'thin' | 'core' for a timestamp. */
export function liquidityState(sched, instrument, ms) {
  if (sched && !isOpen(sched, ms)) return 'closed';
  const L = LIQUIDITY[instrument];
  if (!L) return 'core';
  const p = zonedParts(ms, L.tz);
  if (p.wd >= 5) return 'thin';
  const min = p.hh * 60 + p.mm;
  return L.core.some(([a, b]) => min >= a && min < b) ? 'core' : 'thin';
}

export const isoDay = (ms, tz) => { const p = zonedParts(ms, tz); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };
