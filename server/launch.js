"use strict";
/* The launch engine.
   Stealth model (v1, creator-signs):
   - The mint keypair is generated HERE, server-side. It is used once to
     partial-sign the create transaction and never persisted — after creation
     the mint authority is the LaunchLab program PDA, so the key is worthless.
   - createLaunchpad is built with createOnly:false, so TOKEN CREATION AND THE
     DEV BUY ARE PART OF ONE ATOMIC FLOW — block 0 is occupied before any bot
     can see the token exists.
   - The creator's wallet signs in the browser (they see the CA only at the
     signing moment, seconds before everyone else). Full-escrow blind mode is
     the v2 upgrade.
   TODO(v2): submit via Jito bundle for hard same-block guarantees when the SDK
   returns the create and buy as separate transactions. */

const {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} = require("@solana/web3.js");
const { NATIVE_MINT } = require("@solana/spl-token");
const BN = require("bn.js");
const CFG = require("./config");
const platform = require("./platform");

let sdk; // lazy-loaded (big module)
async function loadSdk() {
  if (!sdk) sdk = await import("@raydium-io/raydium-sdk-v2");
  return sdk;
}

const connection = new Connection(CFG.RPC_URL, "confirmed");

function programId(s) {
  return CFG.IS_MAINNET ? s.LAUNCHPAD_PROGRAM : s.DEVNET_PROGRAM_ID.LAUNCHPAD_PROGRAM;
}

const LAMPORTS = 1_000_000_000;

/* ---- live SOL price (cached 5 min) anchors the USD mcap targets ---- */
let _px = { v: 0, t: 0 };
async function solUsd() {
  if (Date.now() - _px.t < 300_000 && _px.v) return _px.v;
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    const j = await r.json();
    const v = Number(j?.solana?.usd);
    if (v > 1) { _px = { v, t: Date.now() }; return v; }
  } catch {}
  try {
    const r = await fetch("https://lite-api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112");
    const j = await r.json();
    const v = Number(Object.values(j?.data || {})[0]?.price);
    if (v > 1) { _px = { v, t: Date.now() }; return v; }
  } catch {}
  return Number(process.env.SOL_USD_FALLBACK || 150);
}

/* ---- the index curve: entry $20k mcap -> graduate $100k mcap ----
   Constant-product with virtual reserves. Price continuity at migration plus
   the two mcap endpoints force the sell fraction:
     x = sqrt(Mg/M0),  f = Mg / (Mg + M0*x)   (~69.1% of supply on the curve)
     raise R = (Mg in SOL) * (1 - f)          (~31% of grad mcap)            */
const SUPPLY_TOKENS = 1_000_000_000;
const DEC = 1_000_000; // 6 decimals
function curveParams(solPx) {
  const M0 = Number(process.env.ENTRY_MCAP_USD || 20_000);
  const Mg = Number(process.env.GRAD_MCAP_USD || 100_000);
  const x = Math.sqrt(Mg / M0);
  const f = Mg / (Mg + M0 * x);
  const MgSol = Mg / solPx;
  const R = MgSol * (1 - f);                      // raise in SOL
  const B0 = R / (x - 1);                         // virtual quote (SOL)
  const A0 = (f * SUPPLY_TOKENS) / (1 - 1 / x);   // virtual base (tokens)
  const sellTokens = Math.round(f * SUPPLY_TOKENS);
  /* cost of buying 1% of supply as the very first buy */
  const onePct = 0.01 * SUPPLY_TOKENS;
  const solPerPct = B0 * (A0 / (A0 - onePct) - 1);
  return {
    supply: new BN(String(SUPPLY_TOKENS)).mul(new BN(String(DEC))),
    totalSellA: new BN(String(sellTokens)).mul(new BN(String(DEC))),
    totalFundRaisingB: new BN(String(Math.round(R * LAMPORTS))),
    raiseSol: R, entryMcapUsd: M0, gradMcapUsd: Mg, sellPct: f * 100, solPerPct, solPx,
  };
}


/** Build the sealed create+dev-buy transaction set for a creator wallet. */
async function prepareLaunch({ creator, name, symbol, uri, devBuyPct }) {
  const s = await loadSdk();
  const { Raydium, TxVersion, LaunchpadConfig, getPdaLaunchpadConfigId } = s;

  const pct = Math.max(0, Math.min(CFG.MAX_DEV_BUY_PCT, Number(devBuyPct) || 0));
  const creatorPk = new PublicKey(creator);
  const mintKeypair = Keypair.generate(); // the sealed CA — never leaves this scope unsigned

  const raydium = await Raydium.load({
    owner: creatorPk, // public key only: txs are built unsigned for the wallet
    connection,
    cluster: CFG.IS_MAINNET ? "mainnet" : "devnet",
    disableFeatureCheck: true,
    disableLoadToken: true,
    blockhashCommitment: "confirmed",
  });

  const pid = programId(s);
  const configId = getPdaLaunchpadConfigId(pid, NATIVE_MINT, 0, 0).publicKey;
  const configAcc = await connection.getAccountInfo(configId);
  if (!configAcc) throw new Error("LaunchLab config not found on " + CFG.NETWORK);
  const configInfo = LaunchpadConfig.decode(configAcc.data);
  const mintBInfo = await raydium.token.getTokenInfo(configInfo.mintB);

  const curve = isMain ? null : curveParams(await solUsd());
  const buyLamports = Math.floor(pct * (curve ? curve.solPerPct : CFG.SOL_PER_PCT) * LAMPORTS);

  /* the platform's main token: reserved ticker, launched with a flat Token-2022
     transfer fee (1% by default). Only the platform admin wallet may launch it. */
  const MAIN = (process.env.MAIN_TOKEN_SYMBOL || "INDEX").toUpperCase();
  const isMain = String(symbol).toUpperCase() === MAIN;
  if (isMain) {
    const adminPk = platform.adminPubkey();
    if (!adminPk || creator !== adminPk) {
      throw new Error("the $" + MAIN + " ticker is reserved for the platform");
    }
  }

  const params = {
    programId: pid,
    mintA: mintKeypair.publicKey,
    decimals: 6,
    name: String(name).slice(0, CFG.MAX_NAME),
    symbol: String(symbol).slice(0, CFG.MAX_SYMBOL),
    uri,
    migrateType: "cpmm",
    configId,
    configInfo,
    mintBDecimals: mintBInfo.decimals,
    mintBProgram: new PublicKey(mintBInfo.programId),
    createOnly: buyLamports === 0, // dev buy rides in the same flow when > 0
    buyAmount: new BN(String(Math.max(buyLamports, 1))),
    slippage: new BN(300), // 3% — first buy on a fresh curve is deterministic
    extraSigners: [mintKeypair],
    txVersion: TxVersion.V0,
    computeBudgetConfig: { units: 600_000, microLamports: 100_000 },
  };
  if (!isMain && curve) {
    /* the index curve — $20k entry, $100k graduation — on every pad launch */
    params.supply = curve.supply;
    params.totalSellA = curve.totalSellA;
    params.totalFundRaisingB = curve.totalFundRaisingB;
  }
  if (isMain) {
    params.transferFeeExtensionParams = {
      transferFeeBasePoints: Number(process.env.MAIN_TOKEN_FEE_BPS || 100), // flat 1%
      maxinumFee: new BN("1000000000000000"), // effectively uncapped (Raydium's field spelling)
    };
  }

  let pfid = platform.platformId();
  if (!pfid) {
    try { pfid = await platform.ensurePlatform(); } catch {}
  }
  if (pfid) params.platformId = pfid;
  params.creatorFeeOn = s.CpmmCreatorFeeOn ? s.CpmmCreatorFeeOn.OnlyTokenB : undefined;

  const { transactions, extInfo } = await raydium.launchpad.createLaunchpad(params);

  // Partial-sign every tx that references the mint with the mint keypair,
  // then hand them to the creator's wallet for the final signature.
  const txs = transactions.map((tx) => {
    try {
      tx.sign([mintKeypair]);
    } catch {
      /* tx without the mint as a required signer */
    }
    return Buffer.from(tx.serialize()).toString("base64");
  });

  return {
    mint: mintKeypair.publicKey.toBase58(),
    poolId: extInfo?.address?.poolId?.toBase58?.() || null,
    devBuyPct: pct,
    devBuySol: buyLamports / LAMPORTS,
    network: CFG.NETWORK,
    curve: curve ? { entryMcapUsd: curve.entryMcapUsd, gradMcapUsd: curve.gradMcapUsd, raiseSol: Math.round(curve.raiseSol), sellPct: Math.round(curve.sellPct * 10) / 10, solUsd: curve.solPx } : null,
    txs,
  };
}

/** Submit creator-signed transactions, in order, atomically as possible. */
async function submitLaunch({ txs }) {
  if (!Array.isArray(txs) || txs.length === 0 || txs.length > 3) {
    throw new Error("bad transaction payload");
  }
  const sigs = [];
  for (const b64 of txs) {
    const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    await connection.confirmTransaction(sig, "confirmed");
    sigs.push(sig);
  }
  return { signatures: sigs };
}

module.exports = { prepareLaunch, submitLaunch, connection, curveParams, solUsd };
