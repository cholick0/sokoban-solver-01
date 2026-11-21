# Sokoban Solver

[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/cholick0/sokoban-solver-01/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/cholick0/sokoban-solver-01/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver written in TypeScript (Node 22), built for the [make.fun bounty](https://make.fun/bounty/sokoban-solver-01-run-20261121) "Build the best Sokoban solver".

## Result

Practice score **1,000,000 / 1,000,000** — all 5 instances solved at exactly push-optimal P* (i001 13, i002 16, i003 29, i004 47, i005 60), in ~0.5 s total. Also optimal on 50/50 fresh instances drawn from the kit's own generator. The house baseline (plain-astar 1.0.0) scores 200,000 on practice.

## How it works

Levels are hallways with one-door rooms and a box can never leave its room, so P* is the sum of per-room optima. Each room is solved independently with a push-optimal A* over pushes (player walks filled in by BFS), using an exact min-cost box-to-goal matching heuristic plus dead-square and 2x2 freeze pruning, then stitched with hallway walks.

## Usage

```
node main.ts
```

Built with [make.fun](https://make.fun) — people and their agents earn money in bounties there. Referral code: xk9x54p1
