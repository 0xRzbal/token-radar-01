// The token radar's model: one snapshot of the protocol universe in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and may add
// pre-token protocols below the watchlist floor: the early rows the radar exists to find. A protocol is
// pre-token when its index entry records no token (no market cap, no CoinGecko id, no symbol); the
// snapshot's live-token protocols are kept apart and shown as the market's own values, never mixed into
// the ranked board.
//
// Implied value fits a log-log regression over the 128 live-token protocols in the snapshot. For each
// such protocol the market cap is real and recorded, so those rows are the calibration set; the model
// was fit offline on them (real market cap as the dependent variable) and the fitted coefficients are
// baked in below. The estimate is:
//
//   log10(implied) = intercept + b1 * log10(tvl_usd) + b2 * change_7d/100
//                              + b3 * category_issuance_rate + b4 * mean_chain_issuance_rate
//   implied         = max(1, round(10^log10(implied)))
//
// The issuance rates are derived from the snapshot itself: for each category and each chain we count
// the share of its protocols that already trade a token (mcap_usd, gecko_id or symbol present) and
// smooth that share toward the snapshot's global rate with a pseudocount alpha=8. Every input reads
// straight from the snapshot's own fields and no protocol name is ever special-cased: the same
// function scores every row. Because these rows have not launched yet, the number is the model's
// claim about what a token might be worth — an estimate, not a promise. The board also keeps the
// decomposed growth/maturity/category/chain terms on each row so the dashboard can show what moved
// the fit.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them and the sandbox may change them. The regression
 * coefficients were fit offline on the snapshot's 128 live-token protocols and are baked in. */
export interface ModelConstants {
  /** Calibrated log-log regression (fitted on the snapshot's live-token protocols). */
  regression_intercept: number;
  regression_b_tvl: number;
  regression_b_growth: number;
  regression_b_category: number;
  regression_b_chain: number;
  /** Pseudocount smoothing the issuance rates toward the snapshot's global rate. */
  smoothing_alpha: number;
  /** Display-only decomposition terms (kept on each row for the dashboard; not part of implied). */
  base_multiple: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  category_mult_min: number;
  category_mult_range: number;
  chain_mult_min: number;
  chain_mult_range: number;
}

export const MODEL: ModelConstants = {
  regression_intercept: 7.1268,
  regression_b_tvl: 0.4964,
  regression_b_growth: -0.0376,
  regression_b_category: -1.5767,
  regression_b_chain: 1.7211,
  smoothing_alpha: 8,
  base_multiple: 0.2,
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.55,
  maturity_range: 0.45,
  maturity_days: 1460,
  unknown_age_days: 365,
  category_mult_min: 0.6,
  category_mult_range: 0.8,
  chain_mult_min: 0.92,
  chain_mult_range: 0.16,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2';

/** How many pre-token protocols below the watchlist floor the early radar carries, by TVL. */
export const EARLY_ROWS = 160;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    category_multiplier: number;
    chain_multiplier: number;
    age_days: number | null;
    category_rate: number;
    chain_rate: number;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with farm plans generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  category_multiplier: number;
  chain_multiplier: number;
  category_rate: number;
  chain_rate: number;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The decomposed display terms and the implied value one protocol gets under `model` and the snapshot's
 * issuance context. Implied value is the calibrated log-log regression; the multiplier terms are kept
 * for the dashboard's explanatory fields only and do not drive the number. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  ctx: IssuanceContext,
): {
  implied: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  categoryMult: number;
  chainMult: number;
  age: number | null;
  categoryRate: number;
  chainRate: number;
} {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const catRate = protocol.category === null ? ctx.globalRate : (ctx.categoryRate.get(protocol.category) ?? ctx.globalRate);
  const categoryMult = model.category_mult_min + catRate * model.category_mult_range;
  let chainRate = ctx.globalRate;
  if (protocol.chains.length > 0) {
    let sum = 0;
    for (const chain of protocol.chains) sum += ctx.chainRate.get(chain) ?? ctx.globalRate;
    chainRate = sum / protocol.chains.length;
  }
  const chainMult = model.chain_mult_min + chainRate * model.chain_mult_range;
  // Calibrated log-log regression over the snapshot's live-token protocols. The same arithmetic is
  // reproduced in the dashboard's impliedOf(), so the page's re-derived number matches the board.
  const g = finite(protocol.change_7d, 0);
  const log10Implied =
    model.regression_intercept +
    model.regression_b_tvl * Math.log10(Math.max(protocol.tvl_usd, 1)) +
    model.regression_b_growth * (g / 100) +
    model.regression_b_category * catRate +
    model.regression_b_chain * chainRate;
  const implied = Math.max(1, Math.round(Math.pow(10, log10Implied)));
  return { implied, growthPct, growthMult, maturityMult, categoryMult, chainMult, age, categoryRate: catRate, chainRate };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol already trades a token, per the snapshot's own token fields. */
const hasToken = (p: SnapshotProtocol): boolean => !isPreToken(p);

/**
 * Token-issuance background taken from the snapshot: for every category and every chain, the share of
 * its protocols that already trade a token, smoothed toward the snapshot's global rate with a small
 * pseudocount so a two-protocol category is not decided by a coin flip. The same numbers feed the
 * value model and are shown in the dashboard, so the ranking and the page agree.
 */
export interface IssuanceContext {
  categoryRate: Map<string, number>;
  chainRate: Map<string, number>;
  globalRate: number;
}

export function buildIssuance(snapshot: Snapshot, model: ModelConstants): IssuanceContext {
  const categoryN = new Map<string, number>();
  const categoryT = new Map<string, number>();
  const chainN = new Map<string, number>();
  const chainT = new Map<string, number>();
  let totalN = 0;
  let totalT = 0;
  for (const p of snapshot.protocols) {
    totalN += 1;
    if (hasToken(p)) totalT += 1;
    if (p.category !== null) {
      categoryN.set(p.category, (categoryN.get(p.category) ?? 0) + 1);
      if (hasToken(p)) categoryT.set(p.category, (categoryT.get(p.category) ?? 0) + 1);
    }
    for (const c of p.chains) {
      chainN.set(c, (chainN.get(c) ?? 0) + 1);
      if (hasToken(p)) chainT.set(c, (chainT.get(c) ?? 0) + 1);
    }
  }
  const globalRate = totalN === 0 ? 0 : totalT / totalN;
  const smooth = (n: number, t: number): number =>
    (t + model.smoothing_alpha * globalRate) / (n + model.smoothing_alpha);
  const categoryRate = new Map(
    [...categoryN.entries()].map(([category, n]) => [category, smooth(n, categoryT.get(category) ?? 0)]),
  );
  const chainRate = new Map(
    [...chainN.entries()].map(([chain, n]) => [chain, smooth(n, chainT.get(chain) ?? 0)]),
  );
  return { categoryRate, chainRate, globalRate };
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/**
 * Sort scored rows by implied value (strictly descending) and assign ranks 1..n. If two rows tie after
 * rounding, the lower-cap one is nudged by $1 and the sort is repeated, so every row keeps a distinct
 * implied value and ranks stay strict. Each entry has `.implied` and `.p` (the protocol).
 */
function rankRows(scored: Array<{ implied: number; p: SnapshotProtocol }>): void {
  let changed = true;
  while (changed) {
    changed = false;
    scored.sort(
      (a, b) =>
        b.implied - a.implied ||
        b.p.tvl_usd - a.p.tvl_usd ||
        (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0),
    );
    for (let i = 0; i < scored.length - 1; i++) {
      if (scored[i].implied === scored[i + 1].implied) {
        scored[i + 1].implied += 1;
        changed = true;
        break;
      }
    }
  }
}

/** The headline sentence's figures: how many watchlist slugs, how many rows, how many live protocols. */
export interface BoardSummary {
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const ctx = buildIssuance(snapshot, model);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries (it cannot, but the
  // board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: pre-token protocols below the watchlist floor, by TVL, capped. Never a replacement
  // for a watchlist row: a chosen protocol stays chosen.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const { implied, growthPct, growthMult, maturityMult, categoryMult, chainMult, age, categoryRate, chainRate } = impliedValue(p, snapshot.as_of, model, ctx);
    return { p, implied, growthPct, growthMult, maturityMult, categoryMult, chainMult, age, categoryRate, chainRate };
  });
  rankRows(scored);
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      base_multiple: model.base_multiple,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      category_multiplier: round4(s.categoryMult),
      chain_multiplier: round4(s.chainMult),
      age_days: s.age,
      category_rate: s.categoryRate,
      chain_rate: s.chainRate,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The likely gas cost, in dollars, of a first transaction on a protocol's chains. */
const GAS_TIERS: ReadonlyArray<readonly [RegExp, number]> = [
  [/ethereum|^eth$/i, 8],
  [/solana/i, 0.5],
  [/tron/i, 0.5],
  [/(arbitrum|optimism|base|linea|polygon|zksync|scroll|blast|mantle|sonic|avalanche|fantom|bsc|binance|monad|plasma)/i, 1.5],
  [/bitcoin|btc/i, 3],
];

function gasCostFor(chains: string[]): number {
  const joined = chains.join(' ');
  for (const [pattern, cost] of GAS_TIERS) if (pattern.test(joined)) return cost;
  return 2;
}

/** The protocol's farming interaction family, from its category. */
function catKind(category: string | null): string {
  const c = (category ?? '').toLowerCase();
  if (/(lend|cdp|collateral)/.test(c)) return 'lend';
  if (/dex/.test(c)) return 'dex';
  if (/yield/.test(c)) return 'yield';
  if (/(restak|liquid restaking)/.test(c)) return 'restak';
  if (/staking/.test(c)) return 'staking';
  if (/bridge/.test(c)) return 'bridge';
  if (/perpetual|derivative|interest rate/.test(c)) return 'perp';
  if (/prediction/.test(c)) return 'prediction';
  if (/(curator|allocator)/.test(c)) return 'vault';
  if (/stable/.test(c)) return 'stable';
  if (/rwa/.test(c)) return 'rwa';
  if (/insurance/.test(c)) return 'insurance';
  if (/options/.test(c)) return 'options';
  if (/basis|leveraged/.test(c)) return 'lev';
  if (/launchpad/.test(c)) return 'launchpad';
  return 'deposit';
}

/** The first, capital-committing interaction: deposit, lend, provide liquidity, stake or mint. */
function coreAction(kind: string, name: string, chain: string, capital: number): string {
  switch (kind) {
    case 'lend':
      return `Supply $${capital} of USDC into ${name} on ${chain}, then borrow a small amount against it so the position is lending and borrowing at once.`;
    case 'dex':
      return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and mint its LP position.`;
    case 'yield':
      return `Deposit $${capital} into ${name}'s highest-yield vault on ${chain} and keep the vault receipt.`;
    case 'restak':
      return `Restake $${capital} of staked ETH through ${name} on ${chain} and hold the liquid restaking receipt.`;
    case 'staking':
      return `Stake $${capital} of ${chain}'s native asset through ${name} and keep the staking receipt.`;
    case 'bridge':
      return `Bridge $${capital} of USDC to ${chain} via ${name} and keep the destination balance active in its app.`;
    case 'perp':
      return `Deposit $${capital} of USDC as margin on ${name} on ${chain} and open one small hedged position.`;
    case 'prediction':
      return `Fund $${capital} and place one market position on ${name} on ${chain}.`;
    case 'vault':
      return `Deposit $${capital} into a ${name} allocation vault on ${chain} and hold the shares.`;
    case 'stable':
      return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold it.`;
    case 'rwa':
      return `Mint $${capital} of ${name}'s tokenized yield asset on ${chain} and hold the receipt.`;
    case 'insurance':
      return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
    case 'options':
      return `Open one covered position on ${name} with $${capital} of collateral on ${chain}.`;
    case 'lev':
      return `Open a small leveraged position on ${name} on ${chain} with $${capital} of margin.`;
    case 'launchpad':
      return `Commit $${capital} to ${name}'s next sale on ${chain} per its published terms.`;
    default:
      return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
  }
}

/** The weekly qualifying interaction, kept small so the address stays visibly active. */
function weeklyAction(kind: string, name: string, capital: number): string {
  switch (kind) {
    case 'lend':
      return `Make one borrow-then-repay cycle each week: borrow a capped amount, then repay it, so the activity lands in every snapshot.`;
    case 'dex':
      return `Swap a small amount through ${name} each week and leave the LP position untouched.`;
    case 'yield':
      return `Re-deposit any accrued yield each week so the vault balance keeps moving.`;
    case 'restak':
    case 'staking':
      return `Claim rewards and re-stake once a week so the account keeps recording activity.`;
    case 'bridge':
      return `Complete one small bridge each week so ${name} sees recurring usage.`;
    case 'perp':
    case 'lev':
      return `Adjust, or close and reopen, one small position each week to stay active.`;
    case 'prediction':
      return `Place and settle one small market position each week.`;
    case 'vault':
      return `Deposit and rebalance a little each week, and vote if delegates are ever proposed.`;
    case 'stable':
      return `Mint and redeem a small amount each week to show two-way use.`;
    case 'rwa':
      return `Mint and burn a small amount each week to exercise two-way redeemability.`;
    case 'insurance':
      return `Renew or adjust one cover each week to keep the policy live.`;
    case 'options':
      return `Execute one small options trade each week to keep the account active.`;
    case 'launchpad':
      return `Check the sale page weekly and complete any whitelist or verification step it asks for.`;
    default:
      return `Make one small deposit or withdraw each week so the address stays active.`;
  }
}

/** The final step: mirror the position on a second chain when the protocol runs on several. */
function finalStep(p: SnapshotProtocol, capital: number, gas: number): FarmStep {
  if (p.chains.length > 1) {
    const second = p.chains[1]!;
    const secondCapital = Math.max(25, Math.floor(capital / 2));
    return {
      text: `Mirror a smaller $${secondCapital} position on ${second} so ${p.name} records activity on more than one chain.`,
      cost: `$${secondCapital} of additional capital and about $${gas} of gas`,
      time: '15 minutes',
    };
  }
  return {
    text: `Write the wallet, the dates and every transaction in a farm log so you can reproduce or unwind the position later.`,
    cost: 'nothing but the log',
    time: '5 minutes',
  };
}

/**
 * A protocol's farm plan: six steps, each an action with a concrete cost and time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age) — the core deposit, the weekly interaction
 * and the points check are chosen by the category, the gas and capital by TVL and chains, and the hold
 * by age. No protocol name is ever special-cased.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const gas = gasCostFor(p.chains);
  const hold = holdDaysFor(age);
  const kind = catKind(p.category);
  const core = coreAction(kind, p.name, chain, capital);
  const weekly = weeklyAction(kind, p.name, capital);
  const last = finalStep(p, capital, gas);
  return [
    {
      text: `Set up a dedicated wallet funded with only the $${capital} you plan to farm, and keep its seed phrase offline.`,
      cost: `under $${gas} of gas to fund and approve the wallet`,
      time: '10 minutes',
    },
    {
      text: core,
      cost: `$${capital} of capital and about $${gas} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: weekly,
      cost: `about $${Math.max(1, Math.round(gas * 0.5))} of gas a week`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the core position for at least ${hold} days so it appears in more than one points snapshot before any token announcement.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `On ${p.name}'s own points or dashboard page, confirm your activity is counted and read the balance; never connect the wallet to a link the protocol does not publish.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: last.text,
      cost: last.cost,
      time: last.time,
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    category_multiplier: row.model.category_multiplier,
    chain_multiplier: row.model.chain_multiplier,
    category_rate: row.model.category_rate,
    chain_rate: row.model.chain_rate,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
