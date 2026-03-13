import { APP_SCHEMA_VERSION, APP_STORAGE_KEY } from "../engine/constants.js";
import { setupStateFromSerializable, setupStateToSerializable } from "../engine/setup.js";
import { stateFromSerializable, stateToSerializable } from "../engine/state.js";

export function loadAppSnapshot() {
  try {
    const raw = window.localStorage.getItem(APP_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const value = JSON.parse(raw);
    if (value.schemaVersion !== APP_SCHEMA_VERSION) {
      return null;
    }
    return {
      schemaVersion: APP_SCHEMA_VERSION,
      tutorialSeen: Boolean(value.tutorialSeen),
      difficulty: value.difficulty ?? "medium",
      matchupHintEnabled: value.matchupHintEnabled !== false,
      screen: value.screen ?? "setup",
      setupState: setupStateFromSerializable(value.setupState),
      gameState: stateFromSerializable(value.gameState),
    };
  } catch {
    return null;
  }
}

export function saveAppSnapshot(snapshot) {
  try {
    const serializable = {
      schemaVersion: APP_SCHEMA_VERSION,
      tutorialSeen: Boolean(snapshot.tutorialSeen),
      difficulty: snapshot.difficulty,
      matchupHintEnabled: snapshot.matchupHintEnabled !== false,
      screen: snapshot.screen,
      setupState: snapshot.setupState ? setupStateToSerializable(snapshot.setupState) : null,
      gameState: snapshot.gameState ? stateToSerializable(snapshot.gameState) : null,
    };
    window.localStorage.setItem(APP_STORAGE_KEY, JSON.stringify(serializable));
  } catch {
    // Ignore quota or serialization failures; gameplay should continue.
  }
}

export function clearAppSnapshot() {
  try {
    window.localStorage.removeItem(APP_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}
