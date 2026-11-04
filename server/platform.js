"use strict";
/* The index PlatformConfig — our own platform identity on Raydium LaunchLab.
   This is what makes the economics ours instead of Raydium's defaults:
   - feeRate 0        → index takes 0% of curve trades ("0% under $100k")
   - creatorFeeRate 0 → creators also earn nothing pre-graduation
   - migrateCpLockNftScale → at graduation the locked LP's fee rights split
     platform / creator / burn (liquidity itself is locked forever either way)
   The platform id is a PDA of the admin key, so it is derived deterministically
   and created on boot if it doesn't exist yet. */

const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const BN = require("bn.js");
const CFG = require("./config");

let sdkP;
async function loadSdk() {
  if (!sdkP) sdkP = import("@raydium-io/raydium-sdk-v2");
  return sdkP;
}

const connection = new Connection(CFG.RPC_URL, "confirmed");

let cachedPlatformId = null; // PublicKey | null
let ensured = false;

function adminKeypair() {
  const raw = process.env.PLATFORM_ADMIN_SECRET;
  if (!raw) return null;
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  } catch (e) {
    console.error("PLATFORM_ADMIN_SECRET is not a valid JSON secret key array");
    return null;
  }
}

/** The platform id launches should use right now (null = Raydium default). */
function platformId() {
  if (CFG.PLATFORM_ID) return new PublicKey(CFG.PLATFORM_ID);
  return cachedPlatformId;
}

/** Derive, and create on-chain if missing. Called at boot; safe to re-run. */
/* Find a CPMM fee-tier config that actually exists on this network.
   Order: env override → Raydium API list → PDA(index 0..4) with a live account. */
async function resolveCpConfig(s, cpmmProgram) {
  const { PublicKey } = require("@solana/web3.js");
  if (process.env.CP_CONFIG_ID) return new PublicKey(process.env.CP_CONFIG_ID);
  const apiBase = CFG.IS_MAINNET ? "https://api-v3.raydium.io" : "https://api-v3-devnet.raydium.io";
  try {
    const r = await fetch(apiBase + "/main/cpmm-config");
    const j = await r.json();
    const list = j?.data || j || [];
    if (Array.isArray(list) && list.length) {
      const best = list.find((c) => c.tradeFeeRate === 2500) || list[0]; // prefer 0.25% tier
      if (best?.id) return new PublicKey(best.id);
    }
  } catch (e) {
    console.log("platform: cpmm-config API unavailable:", e.message);
  }
  for (let i = 0; i < 5; i++) {
    const pda = s.getPdaAmmConfigId(cpmmProgram, i).publicKey;
    if (await connection.getAccountInfo(pda)) return pda;
  }
  throw new Error("no live CPMM config found on " + CFG.NETWORK + " — set CP_CONFIG_ID env var");
}

async function ensurePlatform() {
  if (ensured) return platformId();
  const admin = adminKeypair();
  if (!admin) {
    console.log("platform: no PLATFORM_ADMIN_SECRET — launches use Raydium's default platform");
    ensured = true;
    return platformId();
  }
  const s = await loadSdk();
  const pid = CFG.IS_MAINNET ? s.LAUNCHPAD_PROGRAM : s.DEVNET_PROGRAM_ID.LAUNCHPAD_PROGRAM;
  const derived = s.getPdaPlatformId(pid, admin.publicKey).publicKey;

  const acc = await connection.getAccountInfo(derived);
  if (acc) {
    cachedPlatformId = derived;
    ensured = true;
    console.log("platform: live —", derived.toBase58());
    return derived;
  }

  /* needs creating — check the admin can pay for it */
  let balance = await connection.getBalance(admin.publicKey);
  if (balance < 0.05 * LAMPORTS_PER_SOL && !CFG.IS_MAINNET) {
    try {
      const sig = await connection.requestAirdrop(admin.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
      balance = await connection.getBalance(admin.publicKey);
      console.log("platform: devnet airdrop ok, balance", balance / LAMPORTS_PER_SOL, "SOL");
    } catch {
      console.log("platform: devnet airdrop failed (faucet limits)");
    }
  }
  if (balance < 0.03 * LAMPORTS_PER_SOL) {
    console.log(
      `platform: NOT created — fund the admin wallet ${admin.publicKey.toBase58()} ` +
      `with ~0.05 SOL (${CFG.NETWORK}) and restart. Launches use Raydium's default platform until then.`
    );
    return platformId(); // not marking ensured: retried on next boot/launch
  }

  const { Raydium, TxVersion, getPdaAmmConfigId } = s;
  const raydium = await Raydium.load({
    owner: admin,
    connection,
    cluster: CFG.IS_MAINNET ? "mainnet" : "devnet",
    disableFeatureCheck: true,
    disableLoadToken: true,
    blockhashCommitment: "confirmed",
  });

  const cpmmProgram = CFG.IS_MAINNET
    ? s.CREATE_CPMM_POOL_PROGRAM
    : s.DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM;
  const cpConfigId = await resolveCpConfig(s, cpmmProgram);
  console.log("platform: using cpConfigId", cpConfigId.toBase58());

  /* PLATFORM_DEBUG=1: simulate variants, print anchor logs naming the failing check */
  if (process.env.PLATFORM_DEBUG === "1") {
    const { PublicKey } = require("@solana/web3.js");
    const base = {
      programId: pid,
      platformAdmin: admin.publicKey,
      platformClaimFeeWallet: admin.publicKey,
      platformLockNftWallet: admin.publicKey,
      platformVestingWallet: admin.publicKey,
      cpConfigId,
      migrateCpLockNftScale: { platformScale: new BN(250000), creatorScale: new BN(250000), burnScale: new BN(500000) },
      transferFeeExtensionAuth: admin.publicKey,
      creatorFeeRate: new BN(0),
      feeRate: new BN(0),
      name: "index", web: "https://launchonindex.fun", img: "https://launchonindex.fun",
      txVersion: s.TxVersion.V0,
    };
    const variants = [
      ["as-is", {}],
      ["vestingWallet=default", { platformVestingWallet: PublicKey.default }],
      ["feeRate=10000", { feeRate: new BN(10000) }],
      ["vestDefault+fee10000", { platformVestingWallet: PublicKey.default, feeRate: new BN(10000) }],
      ["docScales+fee10000", { migrateCpLockNftScale: { platformScale: new BN(100000), creatorScale: new BN(100000), burnScale: new BN(800000) }, feeRate: new BN(10000), platformVestingWallet: PublicKey.default }],
    ];
    for (const [label, over] of variants) {
      try {
        const { transactions } = await raydium.launchpad.createPlatformConfig({ ...base, ...over });
        const tx = transactions ? transactions[0] : (await raydium.launchpad.createPlatformConfig({ ...base, ...over })).transactions?.[0];
        const built = tx || null;
        let vtx = built;
        if (!vtx) {
          const r2 = await raydium.launchpad.createPlatformConfig({ ...base, ...over });
          vtx = r2.transaction || (r2.transactions && r2.transactions[0]);
        }
        vtx.sign([admin]);
        const sim = await connection.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true });
        const logs = (sim.value.logs || []).filter(l => /Error|error|left|right|Instruction:/.test(l)).slice(-6);
        console.log(`probe[${label}]: err=${JSON.stringify(sim.value.err)} :: ${logs.join(" | ")}`);
      } catch (e) {
        console.log(`probe[${label}]: build failed: ${e.message || e}`);
      }
    }
    console.log("probe done — set PLATFORM_DEBUG=0 and apply the passing variant");
    return platformId();
  }

  const M = 1_000_000; // scale denominator = 100%
  const { execute } = await raydium.launchpad.createPlatformConfig({
    programId: pid,
    platformAdmin: admin.publicKey,
    platformClaimFeeWallet: admin.publicKey,
    platformLockNftWallet: admin.publicKey,
    platformVestingWallet: admin.publicKey,
    cpConfigId,
    migrateCpLockNftScale: {
      platformScale: new BN(Number(process.env.PLATFORM_SCALE || 250_000)),  // 25% of LP fee rights
      creatorScale:  new BN(Number(process.env.CREATOR_SCALE  || 250_000)),  // 25%
      burnScale:     new BN(Number(process.env.BURN_SCALE     || 500_000)),  // 50% dead
    },
    transferFeeExtensionAuth: admin.publicKey,
    creatorFeeRate: new BN(Number(process.env.CREATOR_FEE_RATE || 0)), // 0% on the curve
    feeRate:        new BN(Number(process.env.PLATFORM_FEE_RATE || 0)), // 0% on the curve — the pledge
    name: process.env.PLATFORM_NAME || "index",
    web:  process.env.PLATFORM_WEB  || "https://launchonindex.fun",
    img:  process.env.PLATFORM_IMG  || "https://launchonindex.fun",
    txVersion: TxVersion.V0,
    computeBudgetConfig: { units: 400_000, microLamports: 50_000 },
  });
  const res = await execute({ sendAndConfirm: true });
  const txId = res?.txId || (Array.isArray(res?.txIds) ? res.txIds[0] : "");
  cachedPlatformId = derived;
  ensured = true;
  console.log(`platform: CREATED ${derived.toBase58()} (tx ${txId}) — 0% curve fee, LP split 25/25/50`);
  return derived;
}

module.exports = { ensurePlatform, platformId, adminPubkey: () => adminKeypair()?.publicKey?.toBase58() || null };
