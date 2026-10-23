import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent } from '../src/booking-ledger.js';
const empty = () => ({ capacity: 4, bookings: {}, receipts: {} });
const book = (id, bookingId, start, end, seats) => ({ id, type: 'book', bookingId, start, end, seats });
test('book, replay and cancel without mutating the prior snapshot', () => {
  const original = empty(), event = book('e1', 'b1', 0, 10, 3);
  const first = applyEvent(original, event);
  assert.equal(first.status, 'applied');
  assert.deepEqual(original, empty());
  assert.equal(applyEvent(first.state, event).status, 'duplicate');
  const cancelled = applyEvent(first.state, { id: 'e2', type: 'cancel', bookingId: 'b1' });
  assert.equal(cancelled.status, 'applied');
  assert.equal(cancelled.state.bookings.b1.active, false);
  assert.equal(first.state.bookings.b1.active, true);
});
test('overlap rejects excess seats but adjacent intervals are allowed', () => {
  const first = applyEvent(empty(), book('e1', 'b1', 0, 10, 4)).state;
  assert.equal(applyEvent(first, book('e2', 'b2', 5, 15, 1)).reason, 'capacity');
  assert.equal(applyEvent(first, book('e3', 'b3', 10, 20, 4)).status, 'applied');
});
