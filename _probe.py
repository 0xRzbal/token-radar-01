import json, sys
p = "/root/lab/makefun/kits/token-radar-01-kit/token-radar-01-kit/input/snapshot.json"
d = json.load(open(p))

def walk(o, path=''):
    if isinstance(o, dict):
        for k, v in o.items():
            if isinstance(v, list) and len(v) > 0 and isinstance(v[0], dict):
                print(path + '/' + k, '= list of', len(v), 'dicts')
                print('  first keys:', list(v[0].keys()))
                return v, v[0]
            else:
                walk(v, path + '/' + k)
    return None, None

lst, first = walk(d)
# dump a couple live and pre-token protocols
if first is not None:
    live = [x for x in lst if x.get('mcap_usd') and isinstance(x.get('mcap_usd'), (int, float)) and x['mcap_usd'] > 0]
    print('\nlive-token protocols with mcap>0:', len(live))
    if live:
        print('sample live:', json.dumps(live[0], indent=1)[:800])
    pret = [x for x in lst if not (x.get('mcap_usd') and isinstance(x.get('mcap_usd'), (int, float)) and x['mcap_usd'] > 0)]
    print('\npre-token (no mcap) count:', len(pret))
    if pret:
        print('sample pre-token:', json.dumps(pret[0], indent=1)[:800])
