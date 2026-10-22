import { Modifier } from "obsidian";

function debounce(delay = 100): MethodDecorator {
  let lastTime = 0;
  let timer: number | undefined;

  return function (_target: object, _propertyKey: string | symbol, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value as (...args: unknown[]) => unknown;
    descriptor.value = function (this: unknown, ...args: unknown[]) {
      const now = Date.now();
      window.clearTimeout(timer);

      if (now - lastTime < delay) {
        return;
      }

      timer = window.setTimeout(() => {
        originalMethod.apply<unknown, unknown[], unknown>(this, args);
        lastTime = 0;
      }, delay);

      lastTime = now;
    };
    return descriptor;
  };
}

function calcDistance(a: M.Position, b: M.Position) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2);
}

function findClosestNodeByBbox(pos: M.Position, nodes: M.Node[]): { node: M.Node; distance: number } {
  return nodes.reduce(
    (prev, cur, idx) => {
      const a: M.Position = [cur.bbox.minX, cur.bbox.minY];
      const b: M.Position = [cur.bbox.maxX, cur.bbox.minY];
      const c: M.Position = [cur.bbox.minX, cur.bbox.maxY];
      const d: M.Position = [cur.bbox.maxX, cur.bbox.maxY];
      const distance = Math.min(calcDistance(pos, a), calcDistance(pos, b), calcDistance(pos, c), calcDistance(pos, d));

      if (idx === 0) {
        return {
          node: cur,
          distance,
        };
      }

      return distance < prev.distance ? { node: cur, distance } : prev;
    },
    { node: {} as M.Node, distance: 0 },
  );
}

function uuid() {
  const first = Math.floor(Math.random() * 9 + 1);
  const rest = String(Math.random()).slice(2, 10);
  const random9 = first + rest;
  return string10To64(Date.now()) + string10To64(random9);
}

function string10To64(str: number | string) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const radix = chars.length;
  let num = typeof str === "string" ? parseInt(str, 10) : str;
  const res = [];

  do {
    const mod = num % radix;
    res.push(chars[mod]);
    num = (num - mod) / radix;
  } while (num > 0);

  return res.join("");
}

const supportedModifiers = ["mod", "ctrl", "meta", "shift", "alt"];
const navigationKeys = ["tab", "enter", "arrowup", "arrowdown", "arrowleft", "arrowright"];

function convertHotkey2Array(hotkey: string): [Modifier[], string] {
  const parts = hotkey
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  let key: string | null = null;

  if (parts.length === 1) {
    key = parts[0];
    if (!navigationKeys.includes(key.toLowerCase()) && !/^[a-zA-Z0-9]$/.test(key)) {
      throw new Error(`Invalid key: ${key}`);
    }
    return [[], key];
  }

  if (parts.length >= 2) {
    const modifierRaw = parts.slice(0, -1);
    const modifiers = modifierRaw.map((item) => {
      const normalized = item.toLowerCase();
      if (!supportedModifiers.includes(normalized)) {
        throw new Error(`Invalid modifier. Expected one of ${supportedModifiers.join(", ")}`);
      }
      return (normalized.charAt(0).toUpperCase() + normalized.slice(1)) as Modifier;
    });

    key = parts[parts.length - 1];
    if (!navigationKeys.includes(key.toLowerCase()) && !/^[a-zA-Z0-9]$/.test(key)) {
      throw new Error(`Invalid key: ${key}`);
    }
    return [modifiers, key];
  }

  throw new Error(`Invalid hotkey format: ${hotkey}`);
}

export { debounce, calcDistance, findClosestNodeByBbox, uuid, convertHotkey2Array };
