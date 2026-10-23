import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
if (!process.env.EVAL_WORKSPACE) throw new Error('EVAL_WORKSPACE is required');
const { applyEvent } = await import(pathToFileURL(resolve(process.env.EVAL_WORKSPACE, 'src/booking-ledger.js')).href);
const empty = () => ({ capacity: 4, bookings: {}, receipts: {} });
const book = (id, bookingId, start, end, seats) => ({ id, type: 'book', bookingId, start, end, seats });
test('capacity checks peak overlap instead of adding every intersecting booking', () => {
  let state = applyEvent(empty(), book('a', 'a', 0, 5, 3)).state;
  state = applyEvent(state, book('b', 'b', 5, 10, 3)).state;
  assert.equal(applyEvent(state, book('c', 'c', 0, 10, 1)).status, 'applied');
  assert.equal(applyEvent(state, book('d', 'd', 4, 6, 2)).reason, 'capacity');
});
test('capacity counts all simultaneously active reservations', () => {
  let state = applyEvent(empty(), book('a', 'a', 0, 10, 2)).state;
  state = applyEvent(state, book('b', 'b', 5, 15, 1)).state;
  assert.equal(applyEvent(state, book('c', 'c', 7, 8, 2)).reason, 'capacity');
});
test('cancellation releases seats, preserves identity and accepts retry of an unreceipted rejection', () => {
  let state = applyEvent(empty(), book('one', 'one', 0, 10, 4)).state;
  const retry = book('retry', 'two', 2, 3, 4), refused = applyEvent(state, retry);
  assert.equal(refused.reason, 'capacity'); assert.equal(refused.state, state);
  assert.equal(Object.hasOwn(state.receipts, 'retry'), false);
  state = applyEvent(state, { id: 'cancel', type: 'cancel', bookingId: 'one' }).state;
  assert.equal(applyEvent(state, retry).status, 'applied');
  assert.equal(applyEvent(state, book('reuse', 'one', 20, 30, 1)).reason, 'booking-exists');
  assert.equal(applyEvent(state, { id: 'cancel-again', type: 'cancel', bookingId: 'one' }).reason, 'booking-not-active');
});
test('replay uses semantic fields and conflicting receipts do not mutate state', () => {
  const event = book('one', 'one', 0, 10, 1), state = applyEvent(empty(), event).state;
  const duplicate = applyEvent(state, { seats: 1, end: 10, start: 0, bookingId: 'one', type: 'book', id: 'one' });
  assert.equal(duplicate.status, 'duplicate'); assert.equal(duplicate.state, state);
  assert.equal(applyEvent(state, { ...event, seats: 2 }).reason, 'event-conflict');
});
test('rejects malformed, unsafe and extra-field events without receipts', () => {
  const state = empty(), valid = book('one', 'one', 0, 10, 1);
  for (const event of [null, [], {}, { ...valid, start: -1 }, { ...valid, end: 0 }, { ...valid, end: Infinity },
    { ...valid, seats: 1.5 }, { ...valid, seats: 5 }, { ...valid, id: '__proto__' }, { ...valid, extra: true },
    { id: 'x', type: 'cancel', bookingId: 'constructor' }]) {
    const out = applyEvent(state, event); assert.equal(out.status, 'rejected'); assert.equal(out.reason, 'invalid-event'); assert.equal(out.state, state);
  }
});
test('applied snapshots share no mutable maps or entries with their inputs', () => {
  const firstEvent = book('a', 'a', 0, 10, 1), first = applyEvent(empty(), firstEvent).state;
  const secondEvent = book('b', 'b', 10, 20, 1), second = applyEvent(first, secondEvent).state;
  second.bookings.a.active = false; second.receipts.a.seats = 99; second.receipts.b.seats = 88;
  assert.equal(first.bookings.a.active, true); assert.equal(first.receipts.a.seats, 1);
  assert.equal(firstEvent.seats, 1); assert.equal(secondEvent.seats, 1);
});
