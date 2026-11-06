// PUBLIC: shipped to builder and play sandboxes.
//
// Applied by the host after the game has initialized and the round is prepared, and
// BEFORE any agent-authored adapter runs. It freezes the realm's built-in
// constructors/prototypes and locks global bindings, so an adapter cannot replace
// input, timing, geometry or collection behaviour the game logic depends on.
// Canvas 2D rendering interfaces stay hookable: observing draw calls is a permitted
// observation mechanism; it cannot change game logic.

/** Interfaces an adapter may wrap to observe rendering. */
export const observableInterfaces = [
  "CanvasRenderingContext2D",
  "CanvasGradient",
  "CanvasPattern",
  "Path2D",
  "TextMetrics",
  "ImageData",
] as const;

/** Expression evaluated in the page main world. Returns a small report. */
export const lockdownSource = String.raw`(() => {
  'use strict';
  const allow = new Set(${JSON.stringify(observableInterfaces)});
  // One-shot host hooks must never be reachable by agent code.
  for (const name of Object.getOwnPropertyNames(globalThis))
    if (name.startsWith('__fn')) { try { delete globalThis[name]; } catch {} }
  for (const script of [...document.querySelectorAll('script')]) script.remove();
  // eval stays callable: the host's own DevTools-protocol evaluations depend on it. The page CSP
  // blocks string compilation in normal page contexts (timers, handlers); see ARCHITECTURE.md.
  const seen = new Set();
  for (const proto of [function(){}, async function(){}, function*(){}, async function*(){}].map(f => Object.getPrototypeOf(f)))
    { seen.add(proto); Object.freeze(proto); }
  let frozen = 0;
  const freeze = value => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return;
    seen.add(value);
    try { Object.freeze(value); frozen++; } catch {}
  };
  const names = Object.getOwnPropertyNames(globalThis);
  for (const name of names) {
    if (allow.has(name) || !/^[A-Z]/.test(name)) continue;
    let value;
    try { value = globalThis[name]; } catch { continue; }
    if (typeof value === 'function') { freeze(value); freeze(value.prototype); }
    else freeze(value); // Math, JSON, Reflect, Intl, Atomics, CSS, WebAssembly ...
  }
  for (const name of ['performance', 'console', 'navigator', 'screen', 'visualViewport'])
    try { freeze(globalThis[name]); } catch {}
  // Lock existing global bindings; agents may still add NEW globals of their own.
  let locked = 0;
  for (const name of names) {
    if (allow.has(name)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    if (!descriptor || !descriptor.configurable) continue;
    try {
      if ('value' in descriptor)
        Object.defineProperty(globalThis, name, {value: descriptor.value, writable: false, configurable: false, enumerable: descriptor.enumerable});
      else
        Object.defineProperty(globalThis, name, {get: descriptor.get, set: descriptor.set, configurable: false, enumerable: descriptor.enumerable});
      locked++;
    } catch {}
  }
  return {frozen, locked, scripts: document.querySelectorAll('script').length,
    canvas_hookable: !Object.isFrozen(CanvasRenderingContext2D.prototype),
    pointer_frozen: Object.isFrozen(PointerEvent.prototype) && Object.isFrozen(Element.prototype)};
})()`;

/** Wrap an adapter module body so it evaluates to its exports object (CSP-exempt CDP evaluate). */
export function adapterExpression(source: string): string {
  return `(() => {\n"use strict";\nconst module = { exports: {} };\nconst exports = module.exports;\n${source}\n;\nreturn module.exports;\n})()`;
}
