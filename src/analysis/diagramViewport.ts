import type { Component } from "obsidian";

/** Keep the diagram frame fixed while moving and scaling its contents. */
export function diagramViewports(stage: HTMLElement, owner: Component) {
  const attach = () => {
    for (const svg of Array.from(stage.querySelectorAll<SVGSVGElement>(".mermaid svg"))) {
      if (svg.closest(".comsift-diagram-viewport")) continue;
      const frame = stage.createDiv();
      frame.className = "comsift-diagram-viewport";
      frame.title = "Ctrl + scroll to zoom; drag to pan";
      svg.before(frame); frame.append(svg);
      let scale = 1, x = 0, y = 0;
      let drag: { id: number; x: number; y: number } | null = null;
      const update = () => { svg.style.transform = `translate(${x}px, ${y}px) scale(${scale})`; };
      const wheel = (event: WheelEvent) => {
        if (!event.ctrlKey) return;
        event.preventDefault(); event.stopPropagation();
        const bounds = frame.getBoundingClientRect();
        const px = event.clientX - bounds.left, py = event.clientY - bounds.top;
        const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? frame.clientHeight : 1);
        const next = Math.max(0.2, Math.min(8, scale * Math.exp(-delta * 0.002)));
        x = px - (px - x) * next / scale;
        y = py - (py - y) * next / scale;
        scale = next; update();
      };
      const down = (event: PointerEvent) => {
        if (event.button !== 0 || (event.target as Element).closest("a")) return;
        event.preventDefault();
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
        frame.setPointerCapture(event.pointerId); frame.addClass("is-panning");
      };
      const move = (event: PointerEvent) => {
        if (!drag || drag.id !== event.pointerId) return;
        x += event.clientX - drag.x; y += event.clientY - drag.y;
        drag.x = event.clientX; drag.y = event.clientY; update();
      };
      const end = () => { drag = null; frame.removeClass("is-panning"); };
      frame.addEventListener("wheel", wheel, { passive: false });
      frame.addEventListener("pointerdown", down);
      frame.addEventListener("pointermove", move);
      frame.addEventListener("pointerup", end);
      frame.addEventListener("pointercancel", end);
      frame.addEventListener("lostpointercapture", end);
      owner.register(() => {
        frame.removeEventListener("wheel", wheel); frame.removeEventListener("pointerdown", down);
        frame.removeEventListener("pointermove", move); frame.removeEventListener("pointerup", end);
        frame.removeEventListener("pointercancel", end); frame.removeEventListener("lostpointercapture", end);
      });
    }
  };
  const observer = new MutationObserver(attach);
  observer.observe(stage, { childList: true, subtree: true });
  owner.register(() => observer.disconnect());
  attach();
}
