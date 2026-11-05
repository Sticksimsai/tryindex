"use strict";
/* Trade indexer — reads the chain so the site can show what Axiom sees.
   Polls getSignaturesForAddress(mint) for every launch (the LaunchLab buy/sell
   instructions always reference the mint), parses each new transaction's
   balance deltas into a trade, and keeps a rolling JSON file per mint:

     trade = { t, sig, trader, side, sol, tokens, priceSol, mcapSol }

   SOL amount comes from the net WSOL movement in the tx (the curve vault is a
   WSOL account, and the trader's temp WSOL account opens and closes at 0), so
   it is exact for both buys and sells. Token amount is the fee payer's token
   balance delta for the mint. Mcap = price * 1B supply. */

const fs = require("node:fs");
const path = require("node:path");
const { PublicKey } = require("@solana/web3.js");
const { connection, solUsd } = require("./launch");
const store = require("./store");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const TR_DIR = path.join(DATA_DIR, "trades");
fs.mkdirSync(TR_DIR, { recursive: true });

const WSOL = "So11111111111111111111111111111111111111112";
const SUPPLY = 1_000_000_000;
const POLL_MS = Number(process.env.INDEXER_POLL_MS || 12_000);
const MAX_TRADES = 3_000;

const mem = new Map(); // mint -> {trades, lastSig}

const fileFor = (m) => path.join(TR_DIR, m + ".json");
function loadMint(mint) {
  if (mem.has(mint)) return mem.get(mint);
  let d = { trades: [], lastSig: null };
  try { d = JSON.parse(fs.readFileSync(fileFor(mint), "utf8")); } catch {}
  /* purge entries recorded by older parse heuristics with implausible mcaps —
     the backfill logic refetches them correctly */
  const before = d.trades.length;
  d.trades = d.trades.filter((t) => t.mcapSol >= 30 && t.mcapSol <= 3_000_000);
  if (d.trades.length !== before) {
    console.log(`indexer: ${mint.slice(0, 6)}… purged ${before - d.trades.length} bad trade(s)`);
  }
  mem.set(mint, d);
  return d;
}
function saveMint(mint) {
  const d = mem.get(mint);
  if (!d) return;
  const tmp = fileFor(mint) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(d));
  fs.renameSync(tmp, fileFor(mint));
}

function parseTrade(tx, mint, sig) {
  if (!tx || !tx.meta || tx.meta.err) return null;
  const msg = tx.transaction.message;
  const keys = msg.staticAccountKeys || msg.accountKeys || [];
  const payer = keys[0] ? keys[0].toBase58() : null;
  if (!payer) return null;

  const sumTok = (list, m, owner) => (list || [])
    .filter((b) => b.mint === m && (!owner || b.owner === owner))
    .reduce((a, b) => a + (b.uiTokenAmount?.uiAmount || 0), 0);

  /* trader's token delta for this mint */
  const tokDelta = sumTok(tx.meta.postTokenBalances, mint, payer)
                 - sumTok(tx.meta.preTokenBalances, mint, payer);
  if (Math.abs(tokDelta) < 1) return null; // metadata / transfer noise

  /* SOL size of the trade — three independent candidates, because routers
     (Axiom etc.) move SOL differently (native vault, WSOL wrap, relayer fees):
       a) net WSOL token movement across the tx
       b) largest single-account lamport change other than the fee payer
          (the curve vault, when it holds native SOL)
       c) the fee payer's own lamport delta minus the tx fee
     Pick the first one that implies a sane market cap. */
  const wsolDelta = Math.abs(sumTok(tx.meta.postTokenBalances, WSOL)
                           - sumTok(tx.meta.preTokenBalances, WSOL));
  let biggest = 0;
  for (let i = 1; i < tx.meta.postBalances.length; i++) {
    biggest = Math.max(biggest, Math.abs(tx.meta.postBalances[i] - tx.meta.preBalances[i]) / 1e9);
  }
  const payerLam = Math.max(0,
    Math.abs(tx.meta.postBalances[0] - tx.meta.preBalances[0]) / 1e9 - tx.meta.fee / 1e9);

  const tokens = Math.abs(tokDelta);
  const MIN_MCAP = 30, MAX_MCAP = 3_000_000; // SOL: ~$4.5k .. $450m — anything else is noise
  let sol = 0;
  for (const cand of [wsolDelta, biggest, payerLam]) {
    if (cand < 1e-6) continue;
    const mcap = (cand / tokens) * SUPPLY;
    if (mcap >= MIN_MCAP && mcap <= MAX_MCAP) { sol = cand; break; }
  }
  if (!sol) return null;

  const side = tokDelta > 0 ? "buy" : "sell";
  const priceSol = sol / tokens;
  return {
    t: (tx.blockTime || Math.floor(Date.now() / 1000)) * 1000,
    sig: sig.signature,
    trader: payer,
    side, sol: Math.round(sol * 1e6) / 1e6,
    tokens: Math.round(tokens),
    priceSol,
    mcapSol: priceSol * SUPPLY,
  };
}

async function updateStats(l, d) {
  if (!d.trades.length) return;
  const last = d.trades[d.trades.length - 1];
  const dayAgo = Date.now() - 86_400_000;
  let vol24 = 0, curveSol = 0;
  const traders = new Set();
  for (const tr of d.trades) {
    if (tr.t > dayAgo) vol24 += tr.sol;
    curveSol += tr.side === "buy" ? tr.sol : -tr.sol;
    traders.add(tr.trader);
  }
  const patch = {
    mint: l.mint,
    mcapSol: last.mcapSol,
    vol24Sol: Math.round(vol24 * 1000) / 1000,
    curveSol: Math.round(Math.max(0, curveSol) * 1000) / 1000,
    traders: traders.size,
    trades: d.trades.length,
    lastTradeAt: last.t,
  };
  try {
    const px = await solUsd();
    patch.mcapUsd = Math.round(last.mcapSol * px);
    const grad = Number(process.env.GRAD_MCAP_USD || 100_000);
    if (patch.mcapUsd >= grad && l.status !== "graduated") {
      patch.status = "graduated";
      patch.graduatedAt = Date.now();
      console.log(`indexer: ${l.symbol} GRADUATED at $${patch.mcapUsd}`);
    }
  } catch {}
  store.upsert(patch);
}

async function pollMint(l) {
  const d = loadMint(l.mint);
  /* recover from an earlier run that advanced the cursor without parsing
     anything: refetch the full recent history once */
  if (!d.trades.length && d.lastSig) {
    console.log(`indexer: ${l.symbol}: cursor set but no trades — backfilling`);
    d.lastSig = null;
  }
  let sigs;
  try {
    const opts = { limit: 50 };
    if (d.lastSig) opts.until = d.lastSig;
    sigs = await connection.getSignaturesForAddress(new PublicKey(l.mint), opts, "confirmed");
  } catch (e) {
    console.log("indexer: sigs failed for", l.symbol, "-", e.message);
    return;
  }
  if (!sigs.length) return;
  const fresh = sigs.filter((s) => !s.err).reverse(); // oldest first
  let added = 0, errors = 0;
  for (const s of fresh) {
    try {
      const tx = await connection.getTransaction(s.signature, {
        maxSupportedTransactionVersion: 127, // v0, v1 and whatever comes next
        commitment: "confirmed",
      });
      const tr = parseTrade(tx, l.mint, s);
      if (tr && !d.trades.some((x) => x.sig === tr.sig)) { d.trades.push(tr); added++; }
    } catch (e) {
      errors++;
      if (errors <= 3) console.log("indexer: tx fetch/parse error on", l.symbol, "-", e.message);
    }
    await new Promise((r) => setTimeout(r, 120)); // stay well under RPC limits
  }
  if (!added && fresh.length) {
    console.log(`indexer: ${l.symbol}: ${fresh.length} new sig(s), parsed 0 trades${errors ? ` (${errors} errors — will retry)` : ""}`);
  }
  /* only advance the cursor when every tx was fetched cleanly, so transient
     RPC misses are retried next cycle instead of being skipped forever */
  if (errors === 0) d.lastSig = sigs[0].signature;
  if (d.trades.length > MAX_TRADES) d.trades = d.trades.slice(-MAX_TRADES);
  saveMint(l.mint);
  if (added) {
    console.log(`indexer: ${l.symbol} +${added} trade${added > 1 ? "s" : ""} (total ${d.trades.length})`);
    await updateStats(l, d);
  }
}

let timer = null, running = false;
async function cycle() {
  if (running) return;
  running = true;
  try {
    /* most recent 40 launches; graduated ones still tracked (post-grad pool
       trades won't hit the mint-indexed curve path often, but stats stay). */
    const all = store.list().slice(0, 40);
    for (const l of all) {
      await pollMint(l);
      await new Promise((r) => setTimeout(r, 200));
    }
  } catch (e) {
    console.log("indexer cycle error:", e.message);
  } finally { running = false; }
}
function start() {
  if (timer) return;
  console.log(`indexer: watching launches every ${POLL_MS / 1000}s`);
  cycle();
  timer = setInterval(cycle, POLL_MS);
}

function tradesFor(mint, limit) {
  const d = loadMint(mint);
  return d.trades.slice(-(limit || 500));
}

module.exports = { start, tradesFor };
