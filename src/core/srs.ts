// Flashcard scheduler settings from prefs (core/src/srs.rs).
import type { SrsSettings } from "./ipc";
import { prefs } from "./store";

const steps = (s: string) => s.split(/[\s,]+/).map(Number).filter((n) => n > 0 && Number.isFinite(n));

export function srsSettings(): SrsSettings {
  return {
    retention: Math.min(0.99, Math.max(0.7, prefs.srsRetention)),
    max_interval: Math.max(1, Math.round(prefs.srsMaxInterval)),
    learning_steps: steps(prefs.srsLearningSteps),
    relearning_steps: steps(prefs.srsRelearningSteps),
    new_per_day: Math.max(0, Math.round(prefs.srsNewPerDay)),
    fuzz: true,
  };
}
