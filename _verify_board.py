import json, sys

b = json.load(open('/root/lab/makefun/token-radar-work/out/board.json'))
rows = b['rows'] if isinstance(b, dict) else b
print('rows', len(rows))
slugs = [r['slug'] for r in rows]
print('unique slugs', len(set(slugs)))
ranks = [r['rank'] for r in rows]
print('ranks 1..N exact:', ranks == list(range(1, len(rows) + 1)))
vals = [r['implied_value_usd'] for r in rows]
print('distinct values:', len(set(vals)))
print('monotonic non-rising:', all(vals[i] >= vals[i+1] for i in range(len(vals) - 1)))
snap = json.load(open('/root/lab/makefun/kits/token-radar-01-kit/token-radar-01-kit/input/snapshot.json'))
wl = set(snap['watchlist'])
print('watchlist size', len(wl), 'covered', wl.issubset(set(slugs)))
bad = [r['slug'] for r in rows if not (3 <= len(r['farm_steps']) <= 12)]
print('farm_steps out of range rows:', len(bad))
print('first row:', json.dumps({k: rows[0][k] for k in ['rank', 'slug', 'implied_value_usd']}))
print('last row:', json.dumps({k: rows[-1][k] for k in ['rank', 'slug', 'implied_value_usd']}))
# min implied check (positive whole)
zeros = [r['slug'] for r in rows if r['implied_value_usd'] < 1]
print('implied<1 rows:', len(zeros))
