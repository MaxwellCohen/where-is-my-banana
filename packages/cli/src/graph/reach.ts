/**
 * Shared client-reachability BFS: seeds plus everything reachable via `neighbors`.
 * Callers decide which edges count (e.g. skip dynamic imports) and which nodes are in scope.
 */
export function bfsReach<K>(seeds: Iterable<K>, neighbors: (key: K) => Iterable<K>): Set<K> {
  const seen = new Set<K>();
  const queue: K[] = [];
  for (const s of seeds) {
    if (!seen.has(s)) {
      seen.add(s);
      queue.push(s);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    for (const next of neighbors(queue[head]!)) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}
