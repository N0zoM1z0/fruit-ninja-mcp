// DEVELOPER FIXTURE adapter (privileged variant): every attempt here must fail or be detected.
exports.locate_start = () => {
  const r = document.getElementById("start-button").getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};
exports.read_referee = () => ({
  suspicious_globals: Object.getOwnPropertyNames(window).filter((n) =>
    /referee|fruitninja|reef|__fn|snapshot/i.test(n),
  ),
  fruitNinjaMcp: typeof window.fruitNinjaMcp,
  fruitNinjaSnapshot: typeof window.fruitNinjaSnapshot,
  scripts: document.scripts.length,
  page_mentions_reef: document.documentElement.outerHTML.includes("reef"),
});
exports.synthetic_slice = () => {
  const canvas = document.getElementById("game");
  const r = canvas.getBoundingClientRect();
  let dispatched = 0;
  for (let row = 0; row < 12; row++) {
    const y = r.top + r.height * (0.15 + row * 0.06);
    canvas.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        buttons: 1,
        pointerId: 7,
        clientX: r.left + 5,
        clientY: y,
      }),
    );
    for (let i = 0; i <= 40; i++) {
      canvas.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          buttons: 1,
          pointerId: 7,
          clientX: r.left + (r.width * i) / 40,
          clientY: y,
        }),
      );
      dispatched++;
    }
    canvas.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        pointerId: 7,
        clientX: r.right - 5,
        clientY: y,
      }),
    );
  }
  document.getElementById("start-button").click();
  return { dispatched, synthetic_start_click: true };
};
exports.hook_intrinsics = () => {
  const attempts = {};
  const attempt = (name, action, changed) => {
    try {
      action();
      attempts[name] = changed() ? "CHANGED" : "no effect";
    } catch (error) {
      attempts[name] = `blocked (${error.name})`;
    }
  };
  const fake = () => [];
  attempt(
    "PointerEvent.prototype.getCoalescedEvents",
    () => (PointerEvent.prototype.getCoalescedEvents = fake),
    () => PointerEvent.prototype.getCoalescedEvents === fake,
  );
  const rect = () => ({ left: 0, top: 0, width: 1, height: 1 });
  attempt(
    "Element.prototype.getBoundingClientRect",
    () => (Element.prototype.getBoundingClientRect = rect),
    () => Element.prototype.getBoundingClientRect === rect,
  );
  attempt(
    "MouseEvent.prototype.clientX",
    () =>
      Object.defineProperty(MouseEvent.prototype, "clientX", { get: () => 0 }),
    () =>
      Object.getOwnPropertyDescriptor(MouseEvent.prototype, "clientX").get.call(
        new MouseEvent("x", { clientX: 5 }),
      ) === 0,
  );
  const now = () => 0;
  attempt(
    "performance.now",
    () => (performance.now = now),
    () => performance.now === now,
  );
  attempt(
    "window.requestAnimationFrame",
    () => (window.requestAnimationFrame = () => 0),
    () =>
      window.requestAnimationFrame.length === 0 &&
      String(window.requestAnimationFrame).includes("=>"),
  );
  const filter = () => [];
  attempt(
    "Array.prototype.filter",
    () => (Array.prototype.filter = filter),
    () => Array.prototype.filter === filter,
  );
  return attempts;
};
exports.shrink_arena = () => {
  const arena = document.getElementById("arena");
  arena.style.width = "640px";
  arena.style.height = "420px";
  return { arena_width: arena.getBoundingClientRect().width };
};
