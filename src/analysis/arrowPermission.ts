import type { CanvasData, CanvasEdge } from "../service/canvasModel";

/** Only the current user request can grant arrow access, never notes or chat history. */
export function explicitArrowRequest(question: string): boolean {
  const text = question.toLowerCase();
  const arrow = /\b(?:arrows?|edges?|connections?|links?|connect|disconnect|rewire)\b/u;
  const action = /\b(?:add|create|make|draw|edit|change|update|remove|delete|connect|disconnect|rewire|reconnect|reverse|relabel|rename|set|move|redirect|adjust|fix)\b/u;
  const negative = /\b(?:do not|don't|dont|never|without)\s+(?:(?:\w+)\s+){0,3}(?:edit|change|modify|touch|remove|delete|connect|disconnect|rewire|arrows?|edges?|connections?|links?)/u;
  const targeted = /\b(?:edit|change|update|remove|delete|reverse|relabel|rename|redirect|adjust|fix|set)\s+(?:(?:the|these|those|selected|existing|all|some|that|this|a|an|type|of|text|label|labels|style|styles|color|colors|colour|colours|routing|inside|within|in|on|to|for|connection|connections|arrow|arrows)\s+){0,8}(?:arrows?|edges?|connections?|links?)\b/u;
  const create = /\b(?:add|create|make|draw)\s+(?:(?:the|a|an|new|some|these|selected|typed|related|same|uncertain)\s+){0,3}(?:arrows?|edges?|connections?|links?)\b/u;
  const rewire = /\b(?:connect|disconnect|rewire|reconnect)\b/u;
  const restyle = /\b(?:dash\w*|dott\w*|solid|styles?|styled|thick\w*|thin\w*|curv\w*|straight|colou?rs?|colou?red|recolou?r\w*|heads?|labels?)\b/u;
  const readQuestion = /^\s*(?:explain|describe|summarize|why|what|how|tell me why)\b/u.test(text);
  return arrow.test(text) && action.test(text) && !negative.test(text) && !readQuestion && (targeted.test(text) || create.test(text) || rewire.test(text) || restyle.test(text));
}

export function modelArrowGrant(answer: string): boolean {
  try {
    const raw = answer.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const value: unknown = JSON.parse(raw);
    return !!value && typeof value === "object" && "allowArrowEdits" in value && value.allowArrowEdits === true;
  } catch { return false; }
}

/** Protect existing relationships even against implicit node deletion or crafted tool output.
 * Auto rerouting caused by moving/resizing a node remains part of normal canvas layout.
 */
export function assertArrowPermission(before: CanvasData, after: CanvasData, granted: boolean): void {
  if (granted) return;
  const originalIds = new Set(before.nodes.map(node => node.id));
  const semantic = (edge: CanvasEdge) => {
    const copy = { ...edge };
    delete copy.fromSide; delete copy.toSide;
    return JSON.stringify(Object.entries(copy).sort(([a], [b]) => a.localeCompare(b)));
  };
  for (const edge of before.edges) {
    const next = after.edges.find(candidate => candidate.id === edge.id);
    if (!next || semantic(edge) !== semantic(next)) throw new Error("Arrow changes require an explicit request in the current prompt. Ask to edit the arrows, then retry.");
    if (edge.fromSide !== next.fromSide || edge.toSide !== next.toSide) {
      const moved = [edge.fromNode, edge.toNode].some(id => {
        const original = before.nodes.find(node => node.id === id), current = after.nodes.find(node => node.id === id);
        return original && current && ["x", "y", "width", "height"].some(key => original[key] !== current[key]);
      });
      if (!moved) throw new Error("Changing arrow joints requires an explicit request in the current prompt.");
    }
  }
  for (const edge of after.edges) {
    if (!before.edges.some(candidate => candidate.id === edge.id) && originalIds.has(edge.fromNode) && originalIds.has(edge.toNode)) {
      throw new Error("Connecting existing nodes requires an explicit request in the current prompt.");
    }
  }
}
