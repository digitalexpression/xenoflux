const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
  && !['__proto__', 'prototype', 'constructor'].includes(value);
const owns = (object, key) => Object.hasOwn(object, key);
export function applyEvent(state, event) {
  const reject = reason => ({ state, status: 'rejected', reason });
  const keys = event?.type === 'book' ? ['id', 'type', 'bookingId', 'start', 'end', 'seats'] : ['id', 'type', 'bookingId'];
  if (!event || Array.isArray(event) || !['book', 'cancel'].includes(event.type)
    || Object.keys(event).length !== keys.length || !keys.every(key => owns(event, key))
    || !validId(event.id) || !validId(event.bookingId)) return reject('invalid-event');
  if (event.type === 'book' && (!Number.isSafeInteger(event.start) || !Number.isSafeInteger(event.end)
    || event.start < 0 || event.end <= event.start || !Number.isSafeInteger(event.seats)
    || event.seats < 1 || event.seats > state.capacity)) return reject('invalid-event');
  if (owns(state.receipts, event.id)) {
    const prior = state.receipts[event.id];
    return keys.every(key => prior[key] === event[key])
      ? { state, status: 'duplicate', reason: null } : reject('event-conflict');
  }
  if (event.type === 'book') {
    if (owns(state.bookings, event.bookingId)) return reject('booking-exists');
    const changes = [[event.start, BigInt(event.seats)], [event.end, -BigInt(event.seats)]];
    for (const value of Object.values(state.bookings)) if (value.active) changes.push([value.start, BigInt(value.seats)], [value.end, -BigInt(value.seats)]);
    const byTime = new Map();
    for (const [time, seats] of changes) byTime.set(time, (byTime.get(time) ?? 0n) + seats);
    let occupied = 0n;
    for (const [, seats] of [...byTime].sort((a, b) => a[0] - b[0])) {
      occupied += seats;
      if (occupied > BigInt(state.capacity)) return reject('capacity');
    }
  } else if (!owns(state.bookings, event.bookingId) || !state.bookings[event.bookingId].active) return reject('booking-not-active');
  const bookings = Object.fromEntries(Object.entries(state.bookings).map(([id, value]) => [id, { ...value }]));
  const receipts = Object.fromEntries(Object.entries(state.receipts).map(([id, value]) => [id, { ...value }]));
  bookings[event.bookingId] = event.type === 'book' ? { start: event.start, end: event.end, seats: event.seats, active: true }
    : { ...bookings[event.bookingId], active: false };
  receipts[event.id] = { ...event };
  return { state: { ...state, bookings, receipts }, status: 'applied', reason: null };
}
