// While the mouse button is down, live-preview blocks keep their current
// rendering (revealed source stays revealed, collapsed stays collapsed) and
// only update when the button is released. Otherwise a click below a
// revealed code/math block collapses it on mousedown, the text jumps up
// under the pointer, and the click turns into a selection of other lines.
import { StateEffect, StateField, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

const setHeld = StateEffect.define<boolean>();

export const pointerHeld = StateField.define<boolean>({
  create: () => false,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setHeld)) return e.value;
    return v;
  },
});

/** The transaction released the mouse button (decorations should catch up). */
export const released = (tr: Transaction) => tr.effects.some((e) => e.is(setHeld) && !e.value);

/** Keep the current decorations for this transaction (button held, only the selection moved). */
export const holdDecorations = (tr: Transaction) => !tr.docChanged && !tr.reconfigured && tr.state.field(pointerHeld, false) === true && !released(tr);

const tracker = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (e.button !== 0) return false;
    view.dispatch({ effects: setHeld.of(true) });
    const up = () => {
      window.removeEventListener("mouseup", up, true);
      window.removeEventListener("blur", up);
      if (view.state.field(pointerHeld, false)) view.dispatch({ effects: setHeld.of(false) });
    };
    window.addEventListener("mouseup", up, true);
    window.addEventListener("blur", up);
    return false;
  },
});

export const pointerHold = [pointerHeld, tracker];
