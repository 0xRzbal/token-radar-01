import json, math

p = "/root/lab/makefun/kits/token-radar-01-kit/token-radar-01-kit/input/snapshot.json"
snap = json.load(open(p))
prots = snap["protocols"]

def has_token(x):
    return not (x.get("mcap_usd") is None and x.get("gecko_id") is None and x.get("symbol") is None)

def is_pretoken(x):
    return not has_token(x)

# issuance context (same smoothing as model.ts, alpha=8)
alpha = 8
total_n = len(prots)
total_t = sum(1 for x in prots if has_token(x))
global_rate = total_t / total_n

from collections import defaultdict
cn, ct = defaultdict(int), defaultdict(int)
hn, ht = defaultdict(int), defaultdict(int)
for x in prots:
    tok = has_token(x)
    if x.get("category"):
        cn[x["category"]] += 1
        if tok: ct[x["category"]] += 1
    for c in x.get("chains") or []:
        hn[c] += 1
        if tok: ht[c] += 1

def smooth(n, t):
    return (t + alpha * global_rate) / (n + alpha)

cat_rate = {k: smooth(v, ct[k]) for k, v in cn.items()}
chain_rate = {k: smooth(v, ht[k]) for k, v in hn.items()}

# live tokens with real mcap and tvl
live = [x for x in prots if isinstance(x.get("mcap_usd"), (int, float)) and x["mcap_usd"] > 0 and x.get("tvl_usd", 0) > 0]
print("live with mcap>0 & tvl>0:", len(live))

def pearson_log(xs, ys):
    n = len(xs)
    mx = sum(xs)/n; my = sum(ys)/n
    num = sum((a-mx)*(b-my) for a,b in zip(xs,ys))
    dx = math.sqrt(sum((a-mx)**2 for a in xs)); dy = math.sqrt(sum((b-my)**2 for b in ys))
    return num/(dx*dy) if dx and dy else 0

# --- baseline: current model implied vs actual mcap
import datetime
as_of = snap["as_of"]
def age_days(listed):
    if not listed: return None
    try:
        a = datetime.date.fromisoformat(as_of); b = datetime.date.fromisoformat(listed)
        return max(0, (a-b).days)
    except Exception: return None

M = dict(base_multiple=0.20, growth_weight=0.5, growth_floor=-60, growth_cap=120,
         maturity_floor=0.55, maturity_range=0.45, maturity_days=1460, unknown_age_days=365,
         category_mult_min=0.6, category_mult_range=0.8, chain_mult_min=0.92, chain_mult_range=0.16)

def implied_cur(x):
    age = age_days(x.get("listed_at"))
    g = x.get("change_7d")
    g = 0 if not isinstance(g,(int,float)) else g
    gp = min(M["growth_cap"], max(M["growth_floor"], g))
    gm = 1 + (gp/100)*M["growth_weight"]
    ag = age if age is not None else M["unknown_age_days"]
    mm = M["maturity_floor"] + (min(max(ag,0),M["maturity_days"])/M["maturity_days"])*M["maturity_range"]
    cr = cat_rate.get(x.get("category") or "", global_rate)
    cm = M["category_mult_min"] + cr*M["category_mult_range"]
    chs = x.get("chains") or []
    chr_ = (sum(chain_rate.get(c, global_rate) for c in chs)/len(chs)) if chs else global_rate
    chm = M["chain_mult_min"] + chr_*M["chain_mult_range"]
    return max(1, round(x["tvl_usd"]*M["base_multiple"]*gm*mm*cm*chm))

lx = [math.log(implied_cur(x)) for x in live]
ly = [math.log(x["mcap_usd"]) for x in live]
print("baseline corr(log implied, log mcap) = %.4f" % pearson_log(lx, ly))

# --- fit log-log regression: log(mcap) = a + b*log(tvl) + c*g + d*logit(cat_rate) + e*chain_rate
def ols(X, y):
    # X: list of rows (with intercept included), y list
    n = len(y); k = len(X[0])
    # normal equations
    A = [[sum(X[i][a]*X[i][b] for i in range(n)) for b in range(k)] for a in range(k)]
    B = [sum(X[i][a]*y[i] for i in range(n)) for a in range(k)]
    # gaussian elimination
    for i in range(k):
        piv = max(range(i,k), key=lambda r: abs(A[r][i]))
        A[i],A[piv]=A[piv],A[i]; B[i],B[piv]=B[piv],B[i]
        if abs(A[i][i]) < 1e-12: continue
        for r in range(i+1,k):
            f = A[r][i]/A[i][i]
            for c in range(i,k): A[r][c] -= f*A[i][c]
            B[r] -= f*B[i]
    coef=[0]*k
    for i in range(k-1,-1,-1):
        if abs(A[i][i])<1e-12: continue
        s=B[i]-sum(A[i][j]*coef[j] for j in range(i+1,k))
        coef[i]=s/A[i][i]
    return coef

X=[]; Y=[]
for x in live:
    cr = cat_rate.get(x.get("category") or "", global_rate)
    cr = min(max(cr,0.01),0.99)
    logit = math.log(cr/(1-cr))
    chs = x.get("chains") or []
    chr_ = (sum(chain_rate.get(c, global_rate) for c in chs)/len(chs)) if chs else global_rate
    g = x.get("change_7d")
    g = 0 if not isinstance(g,(int,float)) else min(120,max(-60,g))
    X.append([1.0, math.log(x["tvl_usd"]), g, logit, chr_])
    Y.append(math.log(x["mcap_usd"]))

coef = ols(X,Y)
names=["intercept","log_tvl","growth_pct","logit_cat_rate","chain_rate"]
for n_,c_ in zip(names,coef): print(f"  {n_}: {c_:.6f}")

pred=[sum(a*b for a,b in zip(X[i],coef)) for i in range(len(Y))]
print("fitted corr(log pred, log actual) = %.4f" % pearson_log(pred, Y))
resid=[Y[i]-pred[i] for i in range(len(Y))]
print("RMSE(log) = %.4f" % math.sqrt(sum(r*r for r in resid)/len(resid)))
