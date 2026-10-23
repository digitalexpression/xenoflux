# Booking ledger coding task

Implement `applyEvent(state, event)` in `src/booking-ledger.js`. This is a pure,
in-memory capacity ledger. It does not promise database concurrency or durability.
Only that source file is editable. Do not modify tests or install dependencies.

State: `{ capacity, bookings, receipts }`. `capacity` is a positive safe integer.
`bookings` maps booking IDs to `{ start, end, seats, active }`; `receipts` maps event
IDs to the original event object. IDs are nonempty ASCII letters/digits, `_` or
`-`, at most 64 characters; `__proto__`, `prototype` and `constructor` are forbidden.
Start/end are safe integer minute offsets from an arbitrary fixed epoch, with
`0 <= start < end`. Seats are a positive safe integer no greater than capacity.
Inputs are valid plain state objects, and transitions must never mutate them.

Events are either `{ id, type: 'book', bookingId, start, end, seats }` or
`{ id, type: 'cancel', bookingId }`, with exactly those own enumerable fields.
Return `{ state, status, reason }` using these rules:

- Malformed events: `rejected`, reason `invalid-event`.
- An existing event ID replayed with the same fields/values, regardless of key
  order: `duplicate`, reason `null`. A different payload with that event ID:
  `rejected`, reason `event-conflict`. Validate shape before replay lookup.
- A booking ID may be used once, including after cancellation; reuse rejects
  with `booking-exists`. Unknown or already inactive cancellation rejects with
  `booking-not-active`.
- Active reservations occupy half-open intervals `[start, end)`. Accept a booking
  only if the sum of seats at **every instant** never exceeds capacity. Multiple
  intervals can overlap the candidate without overlapping each other; do not add
  their seats as though they were simultaneous. Rejection reason: `capacity`.
- Accepted transitions have status `applied`, reason `null`, and retain a copy of
  the event in receipts. Cancellation marks the booking inactive and releases its
  seats. Rejected events are not receipted, so they can be retried later.

For rejected/duplicate results, return the original state object. For applied
results, return a new state with new bookings/receipts maps; retain no mutable
aliases to the input maps, booking entries or receipt entries. Mutating a returned
snapshot must not change the previous state or the event object supplied by the
caller. Never use wall-clock time, I/O or ambient state.

Run `node --test test/visible.test.js`.
