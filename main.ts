// Sokoban solver: every level is a hallway with rooms off it (one door each), and a box
// pushed out of its room can never come back, so a level's push-optimal count is the sum
// of its rooms' optima. This program solves each room on its own with a push-optimal
// A* (pushes only; the player moves inside a push are filled in by walk BFS), then
// stitches the rooms together with walks along the hallway.
//
// Search budget is by work (state expansions), never by the clock, so two runs write
// the same bytes. Node 22, erasable TypeScript only, node builtins only.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const LETTER = ['u', 'd', 'l', 'r'];

// Expansion budgets (work, not time). Rooms here are at most 6x6 with 3-4 boxes and
// optima of 12-17 pushes, so these caps sit far above what a room needs.
const ROOM_CAP = 400_000;
const ROOM_CAP_RETRY = 1_600_000;
const WHOLE_CAP = 800_000;
const TOTAL_CAP = 4_000_000;
let totalExp = 0;

interface Level {
  w: number;
  h: number;
  wall: boolean[];
  goals: number[];
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall: boolean[] = new Array(w * h).fill(true);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = 0;
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? '#';
      const i = y * w + x;
      wall[i] = ch === '#';
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

function popcount(n: number): number {
  let c = 0;
  while (n) {
    n &= n - 1;
    c++;
  }
  return c;
}

// Walk path (direction indices) from `from` to `to` over `allowed` cells, treating
// `blocked` cells as obstacles. Deterministic BFS in fixed direction order.
function walkPath(
  from: number,
  to: number,
  allowed: boolean[],
  blocked: boolean[],
  w: number,
  h: number,
): number[] | null {
  if (from === to) return [];
  const n = w * h;
  const prev = new Int32Array(n).fill(-2);
  const prevDir = new Int8Array(n).fill(-1);
  prev[from] = -1;
  const q = [from];
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi]!;
    const cx = c % w;
    const cy = Math.floor(c / w);
    for (let d = 0; d < 4; d++) {
      const nx = cx + DX[d]!;
      const ny = cy + DY[d]!;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const nn = ny * w + nx;
      if (!allowed[nn] || blocked[nn] || prev[nn] !== -2) continue;
      prev[nn] = c;
      prevDir[nn] = d;
      if (nn === to) {
        const path: number[] = [];
        let cur = nn;
        while (cur !== from) {
          path.push(prevDir[cur]!);
          cur = prev[cur]!;
        }
        path.reverse();
        return path;
      }
      q.push(nn);
    }
  }
  return null;
}

interface Room {
  door: number; // door cell, inside the room
  hallCell: number; // hallway cell beside the door
  cells: boolean[]; // room floor cells, board-indexed
  boxes: number[];
  goals: number[];
}

// Split a level into its hallway row and the rooms off it. Returns null when the
// level does not fit that shape, so the caller falls back to a whole-level search.
function findRooms(lv: Level): Room[] | null {
  const { w, h, wall, goals, boxes, player } = lv;
  const hr = Math.floor(player / w);
  const rooms: Room[] = [];
  const coverCount = new Int32Array(w * h);
  for (let x = 0; x < w; x++) {
    for (const dr of [-1, 1]) {
      const r = hr + dr;
      if (r < 0 || r >= h) continue;
      const door = r * w + x;
      const hall = hr * w + x;
      if (wall[door] || wall[hall]) continue;
      const cells: boolean[] = new Array(w * h).fill(false);
      const stack = [door];
      cells[door] = true;
      while (stack.length) {
        const c = stack.pop()!;
        const cx = c % w;
        const cy = Math.floor(c / w);
        for (let d = 0; d < 4; d++) {
          const nx = cx + DX[d]!;
          const ny = cy + DY[d]!;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          if (ny === hr) continue; // never cross the hallway row
          const nn = ny * w + nx;
          if (wall[nn] || cells[nn]) continue;
          cells[nn] = true;
          stack.push(nn);
        }
      }
      for (let i = 0; i < w * h; i++) if (cells[i]) coverCount[i]++;
      rooms.push({
        door,
        hallCell: hall,
        cells,
        boxes: boxes.filter((b) => cells[b]),
        goals: goals.filter((g) => cells[g]),
      });
    }
  }
  if (rooms.length === 0) return null;
  // Every box and goal must sit in exactly one room.
  for (const b of boxes) if (coverCount[b] !== 1) return null;
  for (const g of goals) if (coverCount[g] !== 1) return null;
  for (const r of rooms) if (r.boxes.length === 0) return null;
  return rooms;
}

interface Push {
  from: number;
  to: number;
  dir: number;
}

// Push-optimal A* over one region (a room, or the whole board as fallback).
// `cells` are the cells boxes may occupy; the player may also stand on `extraCell`
// (the hallway cell beside a room's door, -1 for none). The player starts on
// `startPlayer` and the search ends with every box on a goal and, when `exitCell`
// is given, the player able to walk to it. Returns the moves (walks + pushes) and
// the push count, or null when the expansion cap runs out.
function solveRegion(
  lv: Level,
  cells: boolean[],
  extraCell: number,
  boxes0: number[],
  goals: number[],
  startPlayer: number,
  exitCell: number,
  cap: number,
): { moves: string; pushes: number } | null {
  const { w, h, wall } = lv;
  const n = w * h;
  const allowed: boolean[] = cells.slice();
  if (extraCell >= 0) allowed[extraCell] = true;
  const isGoal: boolean[] = new Array(n).fill(false);
  for (const g of goals) isGoal[g] = true;
  const nb = boxes0.length;
  const ng = goals.length;

  // Live cells: a box on one can still be pushed onto a goal (pull-BFS from the
  // goals, ignoring other boxes). Anything else is dead ground.
  const live: boolean[] = new Array(n).fill(false);
  {
    const q: number[] = [];
    for (const g of goals) {
      live[g] = true;
      q.push(g);
    }
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi]!;
      const cx = c % w;
      const cy = Math.floor(c / w);
      for (let d = 0; d < 4; d++) {
        const bx = cx - DX[d]!;
        const by = cy - DY[d]!;
        const px = cx - 2 * DX[d]!;
        const py = cy - 2 * DY[d]!;
        if (bx < 0 || bx >= w || by < 0 || by >= h) continue;
        if (px < 0 || px >= w || py < 0 || py >= h) continue;
        const b = by * w + bx;
        const p = py * w + px;
        if (!cells[b] || !allowed[p] || live[b]) continue;
        live[b] = true;
        q.push(b);
      }
    }
  }

  // BFS distances from each goal over the region (boxes ignored).
  const dist: number[][] = [];
  for (let j = 0; j < ng; j++) {
    const d: number[] = new Array(n).fill(Infinity);
    const q = [goals[j]!];
    d[goals[j]!] = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi]!;
      const cx = c % w;
      const cy = Math.floor(c / w);
      for (let dd = 0; dd < 4; dd++) {
        const nx = cx + DX[dd]!;
        const ny = cy + DY[dd]!;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const nn = ny * w + nx;
        if (!cells[nn] || d[nn] !== Infinity) continue;
        d[nn] = d[c]! + 1;
        q.push(nn);
      }
    }
    dist.push(d);
  }

  // Cheapest assignment of boxes to goals (exact, <= 6 boxes). Admissible: one push
  // moves one box one square, so no solution beats the matched distances. With more
  // boxes the exact matching costs 2^n per call, so the sum of nearest distances
  // (still admissible) stands in instead.
  const heuristic = (bs: number[]): number => {
    if (nb !== ng || nb > 6) {
      let s = 0;
      for (const b of bs) {
        let m = Infinity;
        for (let j = 0; j < ng; j++) m = Math.min(m, dist[j]![b]!);
        if (m === Infinity) return Infinity;
        s += m;
      }
      return s;
    }
    const size = 1 << nb;
    const dp: number[] = new Array(size).fill(Infinity);
    dp[0] = 0;
    for (let mask = 0; mask < size; mask++) {
      if (dp[mask] === Infinity) continue;
      const i = popcount(mask);
      if (i >= nb) continue;
      for (let j = 0; j < ng; j++) {
        if (mask & (1 << j)) continue;
        const c = dist[j]![bs[i]!]!;
        if (c === Infinity) continue;
        const nm = mask | (1 << j);
        const v = dp[mask]! + c;
        if (v < dp[nm]!) dp[nm] = v;
      }
    }
    return dp[size - 1]!;
  };

  // The player's reachable region from a cell, boxes as obstacles.
  const regionOf = (playerCell: number, bs: number[]): { min: number; has: boolean[] } => {
    const blocked: boolean[] = new Array(n).fill(false);
    for (const b of bs) blocked[b] = true;
    const has: boolean[] = new Array(n).fill(false);
    const q = [playerCell];
    has[playerCell] = true;
    let min = playerCell;
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi]!;
      if (c < min) min = c;
      const cx = c % w;
      const cy = Math.floor(c / w);
      for (let d = 0; d < 4; d++) {
        const nx = cx + DX[d]!;
        const ny = cy + DY[d]!;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const nn = ny * w + nx;
        if (!allowed[nn] || blocked[nn] || has[nn]) continue;
        has[nn] = true;
        q.push(nn);
      }
    }
    return { min, has };
  };

  // A 2x2 block of walls and boxes with a box off its goal can never move. A cell
  // counts as blocking when it is a wall, a box, or one the player cannot stand on
  // (the hallway cell beside the door is free ground for the player, so it does not
  // block). Only windows holding `cell` can newly freeze when a box lands on it.
  const freezeAt = (bs: number[], cell: number): boolean => {
    const isBox: boolean[] = new Array(n).fill(false);
    for (const b of bs) isBox[b] = true;
    const cx = cell % w;
    const cy = Math.floor(cell / w);
    for (let oy = -1; oy <= 0; oy++) {
      for (let ox = -1; ox <= 0; ox++) {
        const x = cx + ox;
        const y = cy + oy;
        if (x < 0 || y < 0 || x + 1 >= w || y + 1 >= h) continue;
        const cs = [y * w + x, y * w + x + 1, (y + 1) * w + x, (y + 1) * w + x + 1];
        let boxCount = 0;
        let allBlocked = true;
        let offGoal = false;
        for (const c of cs) {
          if (isBox[c]) {
            boxCount++;
            if (!isGoal[c]) offGoal = true;
          } else if (wall[c] || !allowed[c]) {
            // blocked for a box and for the player
          } else {
            allBlocked = false;
          }
        }
        if (boxCount > 0 && allBlocked && offGoal) return true;
      }
    }
    return false;
  };

  const solved = (bs: number[]): boolean => bs.every((b) => isGoal[b]);

  // A* nodes.
  const nBoxes: number[][] = [boxes0.slice()];
  const nPlayer: number[] = [startPlayer];
  const nRegionMin: number[] = [regionOf(startPlayer, boxes0).min];
  const nParent: number[] = [-1];
  const nPush: (Push | null)[] = [null];
  const nG: number[] = [0];
  const stateKey = (bs: number[], regionMin: number): string => bs.join(',') + ':' + regionMin;
  const best = new Map<string, number>();
  best.set(stateKey(boxes0, nRegionMin[0]!), 0);

  // Binary heap on [f, -g, insertion order, node]. Fixed tie-breaks keep it deterministic.
  const heap: [number, number, number, number][] = [];
  const heapLess = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i]!, heap[p]!)) break;
      const t = heap[i]!;
      heap[i] = heap[p]!;
      heap[p] = t;
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
        if (!heapLess(heap[c]!, heap[i]!)) break;
        const t = heap[i]!;
        heap[i] = heap[c]!;
        heap[c] = t;
        i = c;
      }
    }
    return top;
  };

  let counter = 0;
  const h0 = heuristic(boxes0);
  if (h0 === Infinity || boxes0.some((b) => !live[b]) || boxes0.some((b) => freezeAt(boxes0, b))) return null;
  heapPush([h0, 0, counter++, 0]);

  let expansions = 0;
  while (heap.length > 0) {
    const [, negG, , idx] = heapPop();
    const g = -negG;
    const bs = nBoxes[idx]!;
    const pc = nPlayer[idx]!;
    if (best.get(stateKey(bs, nRegionMin[idx]!)) !== idx) continue; // stale node
    if (solved(bs)) {
      if (exitCell < 0 || regionOf(pc, bs).has[exitCell]) {
        // Rebuild the moves: walk to behind each pushed box, push, and at the end
        // walk out through the door.
        const pushes: Push[] = [];
        const parents: number[] = [];
        let cur = idx;
        while (nParent[cur]! >= 0) {
          pushes.push(nPush[cur]!);
          parents.push(nParent[cur]!);
          cur = nParent[cur]!;
        }
        pushes.reverse();
        parents.reverse();
        let moves = '';
        let playerCell = startPlayer;
        let curBoxes = boxes0.slice();
        for (let k = 0; k < pushes.length; k++) {
          const p = pushes[k]!;
          const parentIdx = parents[k]!;
          const parentBoxes = nBoxes[parentIdx]!;
          const behind = p.from - (DY[p.dir]! * w + DX[p.dir]!);
          const blocked: boolean[] = new Array(n).fill(false);
          for (const b of parentBoxes) blocked[b] = true;
          const walk = walkPath(playerCell, behind, allowed, blocked, w, h);
          if (walk === null) return null;
          moves += walk.map((d) => LETTER[d]).join('') + LETTER[p.dir];
          const at = curBoxes.indexOf(p.from);
          curBoxes[at] = p.to;
          curBoxes.sort((a, b) => a - b);
          playerCell = p.from;
        }
        if (exitCell >= 0) {
          const blocked: boolean[] = new Array(n).fill(false);
          for (const b of curBoxes) blocked[b] = true;
          const walk = walkPath(playerCell, exitCell, allowed, blocked, w, h);
          if (walk === null) return null;
          moves += walk.map((d) => LETTER[d]).join('');
          const dx = (extraCell % w) - (exitCell % w);
          const dy = Math.floor(extraCell / w) - Math.floor(exitCell / w);
          let d = -1;
          for (let dd = 0; dd < 4; dd++) {
            if (DX[dd] === dx && DY[dd] === dy) d = dd;
          }
          if (d < 0) return null;
          moves += LETTER[d]!;
        }
        return { moves, pushes: pushes.length };
      }
    }
    if (expansions >= cap || totalExp >= TOTAL_CAP) return null;
    expansions++;
    totalExp++;
    const reg = regionOf(pc, bs);
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i]!;
      const bx = b % w;
      const by = Math.floor(b / w);
      for (let d = 0; d < 4; d++) {
        const tx = bx + DX[d]!;
        const ty = by + DY[d]!;
        if (tx < 0 || tx >= w || ty < 0 || ty >= h) continue;
        const t = ty * w + tx;
        if (!cells[t] || bs.includes(t)) continue;
        const sx = bx - DX[d]!;
        const sy = by - DY[d]!;
        if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
        const s = sy * w + sx;
        if (!reg.has[s]) continue; // the player cannot stand behind the box
        const nb2 = bs.slice();
        nb2[i] = t;
        nb2.sort((a, b2) => a - b2);
        if (!live[t]) continue; // only the moved box can newly sit on dead ground
        if (freezeAt(nb2, t)) continue;
        const hv = heuristic(nb2);
        if (hv === Infinity) continue;
        const g2 = g + 1;
        const regMin2 = regionOf(b, nb2).min;
        const k2 = stateKey(nb2, regMin2);
        const prev = best.get(k2);
        if (prev !== undefined && nG[prev]! <= g2) continue;
        const ni = nBoxes.length;
        nBoxes.push(nb2);
        nPlayer.push(b);
        nRegionMin.push(regMin2);
        nParent.push(idx);
        nPush.push({ from: b, to: t, dir: d });
        nG.push(g2);
        best.set(k2, ni);
        heapPush([g2 + hv, -g2, counter++, ni]);
      }
    }
  }
  return null;
}

function solveLevel(text: string): string {
  const lv = parseLevel(text);
  const allFloor: boolean[] = lv.wall.map((v) => !v);
  const rooms = findRooms(lv);
  if (rooms) {
    rooms.sort((a, b) => (a.door % lv.w) - (b.door % lv.w) || Math.floor(a.door / lv.w) - Math.floor(b.door / lv.w));
    let moves = '';
    let playerCell = lv.player;
    const curBoxes = lv.boxes.slice();
    for (const room of rooms) {
      // Walk the player to the hallway cell beside this room's door.
      const blocked: boolean[] = new Array(lv.w * lv.h).fill(false);
      for (const b of curBoxes) blocked[b] = true;
      const walk = walkPath(playerCell, room.hallCell, allFloor, blocked, lv.w, lv.h);
      if (walk === null) return '';
      moves += walk.map((d) => LETTER[d]).join('');
      playerCell = room.hallCell;
      let res = solveRegion(lv, room.cells, room.hallCell, room.boxes, room.goals, room.hallCell, room.door, ROOM_CAP);
      if (res === null) res = solveRegion(lv, room.cells, room.hallCell, room.boxes, room.goals, room.hallCell, room.door, ROOM_CAP_RETRY);
      if (res === null) return solveWhole(lv);
      moves += res.moves;
      // The room's boxes end on its goals; the player ends outside, in the hallway.
      playerCell = room.hallCell;
      const solvedBoxes = room.goals.slice();
      const nextBoxes: number[] = [];
      for (const b of curBoxes) {
        if (!room.cells[b]) nextBoxes.push(b);
      }
      nextBoxes.push(...solvedBoxes);
      nextBoxes.sort((a, b) => a - b);
      curBoxes.length = 0;
      curBoxes.push(...nextBoxes);
    }
    return moves;
  }
  return solveWhole(lv);
}

// Fallback: one push-optimal search over the whole board, no exit requirement.
// Only attempted on small boards; on a big board it cannot finish in budget, and
// a timed-out run earns nothing, so there the level is left unanswered instead.
function solveWhole(lv: Level): string {
  if (lv.boxes.length > 8) return '';
  const allCells: boolean[] = lv.wall.map((v) => !v);
  const res = solveRegion(lv, allCells, -1, lv.boxes, lv.goals, lv.player, -1, WHOLE_CAP);
  return res === null ? '' : res.moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
