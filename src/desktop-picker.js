// The desktop picker keeps the ordinary Codex environment separate from
// persisted profile IDs.  It only chooses or previews; lifecycle work remains
// in desktop-selection.js.
import { listHomes } from './homes.js';
import { pickProfile } from './picker.js';
import { currentDesktop, selectionPlan, restoreDesktop, switchDesktop } from './desktop-selection.js';

const defaultEntryId = Symbol('default-desktop-environment');

function defaultEntry(current) {
  if (current.recoveryRequired) {
    return {
      id: defaultEntryId,
      name: 'Default profile',
      description: 'Desktop recovery is required before changing the desktop. Run desktop recover.',
      state: 'unavailable',
      home: null,
    };
  }
  if (current.status !== 'active') {
    return {
      id: defaultEntryId,
      name: 'Default profile',
      description: 'No managed desktop selection; leave the current app unchanged.',
      state: 'ready',
      home: null,
    };
  }
  return {
    id: defaultEntryId,
    name: 'Default profile',
    description: 'Restore the ordinary Codex desktop and release Xenoflux reservations.',
    state: 'ready',
    home: null,
  };
}

function choiceFor(value) {
  if (value === defaultEntryId) return { kind: 'default' };
  if (typeof value === 'string') return { kind: 'profile', profileId: value };
  return null;
}

function validChoice(choice) {
  if (choice?.kind === 'default') return 'default';
  if (choice?.kind === 'profile' && typeof choice.profileId === 'string' && choice.profileId) return 'profile';
  throw new Error('Invalid desktop choice');
}

/** Choose either the ordinary desktop or one listed native-home profile. */
export async function pickDesktop(store, { listHomes: list = listHomes, pickProfile: pick = pickProfile,
  currentDesktop: current = currentDesktop, selectionPlan: selection = selectionPlan, inspect, ...pickerOptions } = {}) {
  const entries = [defaultEntry(await current(store)), ...await list(store)];
  const selected = await pick(entries, {
    ...pickerOptions,
    actionLabel: 'select desktop',
    async inspect(id) {
      const choice = choiceFor(id);
      if (!choice) throw new Error('Invalid desktop choice');
      return inspect ? inspect(choice) : desktopChoicePlan(store, choice, { selectionPlan: selection });
    },
  });
  return choiceFor(selected);
}

/** Preview a choice without performing desktop lifecycle actions. */
export async function desktopChoicePlan(store, choice, { selectionPlan: selection = selectionPlan, ...options } = {}) {
  if (validChoice(choice) === 'default') {
    return {
      kind: 'default', operation: 'restore', launch: 'ordinary-app',
      homeOverrides: 'none', reservationAction: 'release-on-restoration',
      lifecycleActionsPerformed: false,
      whenUnmanaged: 'leave-unchanged', whenNoPriorSelection: 'leave-unchanged',
      liveHomeChanged: false,
    };
  }
  return selection(store, choice.profileId, options);
}

/** Apply a selected choice through the established desktop lifecycle. */
export async function selectDesktop(store, choice, { switchDesktop: switchOperation = switchDesktop,
  restoreDesktop: restoreOperation = restoreDesktop, ...options } = {}) {
  if (choice === null) return { status: 'cancelled' };
  return validChoice(choice) === 'default'
    ? restoreOperation(store, options)
    : switchOperation(store, choice.profileId, options);
}
