"use strict";
/* The index PlatformConfigs — our platform identities on Raydium LaunchLab.
   TWO platforms, because LaunchLab fee rates are fixed per platform:

   1. PAD platform (PLATFORM_ADMIN_SECRET) — every normal launch:
      feeRate 0 (0% curve) · creatorFeeRate 0.25% · 1% CPMM tier · LP fee rights -> platform

   2. MAIN platform (MAIN_PLATFORM_ADMIN_SECRET) — the $INDEX token itself:
      feeRate 0 · creatorFeeRate 0 · 1% CPMM tier · LP fee rights -> platform
      => 0% until $100k, then the 1% pool fee flows entirely to the admin side
      (its claim wallets point at the PAD admin so all revenue lands in one wallet)

   Platform ids are PDAs of their admin keys; both are created on boot if missing. */

const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } = require("@solana/web3.js");
const BN = require("bn.js");
const CFG = require("./config");

let sdkP;
async function loadSdk() {
  if (!sdkP) sdkP = import("@raydium-io/raydium-sdk-v2");
  return sdkP;
}

const connection = new Connection(CFG.RPC_URL, "confirmed");

const state = {
  pad: { id: null, ensured: false },
  main: { id: null, ensured: false },
};

function keypairFromEnv(name) {
  const raw = process.env[name];
  if (!raw) return null;
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  } catch {
    console.error(name, "is not a valid JSON secret key array");
    return null;
  }
}
const padAdmin = () => keypairFromEnv("PLATFORM_ADMIN_SECRET");
const mainAdmin = () => keypairFromEnv("MAIN_PLATFORM_ADMIN_SECRET");

function platformId() {
  if (CFG.PLATFORM_ID) return new PublicKey(CFG.PLATFORM_ID);
  return state.pad.id;
}
function mainPlatformId() {
  return state.main.id;
}

/* Find a CPMM fee-tier config that actually exists on this network. */
async function resolveCpConfig(s, cpmmProgram) {
  if (process.env.CP_CONFIG_ID) return new PublicKey(process.env.CP_CONFIG_ID);
  const WANT = Number(process.env.POOL_FEE_RATE || 10_000); // 1% tier
  const apiBase = CFG.IS_MAINNET ? "https://api-v3.raydium.io" : "https://api-v3-devnet.raydium.io";
  try {
    const r = await fetch(apiBase + "/main/cpmm-config");
    const j = await r.json();
    const list = j?.data || j || [];
    if (Array.isArray(list) && list.length) {
      const best = list.find((c) => Number(c.tradeFeeRate) === WANT);
      if (best?.id) { console.log(`platform: cpmm tier ${WANT} from API`); return new PublicKey(best.id); }
      console.log("platform: API has no tier", WANT, "- probing PDAs");
    }
  } catch (e) {
    console.log("platform: cpmm-config API unavailable:", e.message);
  }
  let fallback = null;
  for (let i = 0; i < 16; i++) {
    const pda = s.getPdaAmmConfigId(cpmmProgram, i).publicKey;
    const acc = await connection.getAccountInfo(pda);
    if (!acc) continue;
    try {
      const cfg = s.CpmmConfigInfoLayout.decode(acc.data);
      const rate = Number(cfg.tradeFeeRate ?? cfg.trade_fee_rate);
      if (rate === WANT) return pda;
      if (!fallback) fallback = pda;
    } catch { if (!fallback) fallback = pda; }
  }
  if (fallback) { console.log("platform: WARNING — wanted tier not found, using fallback config"); return fallback; }
  throw new Error("no live CPMM config found on " + CFG.NETWORK + " — set CP_CONFIG_ID");
}

/** Top up `to` from the pad admin when it can't pay its own rent. */
async function topUpFrom(fromKp, toPk, lamports) {
  const bal = await connection.getBalance(fromKp.publicKey);
  if (bal < lamports + 0.01 * LAMPORTS_PER_SOL) return false;
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: fromKp.publicKey, toPubkey: toPk, lamports,
  }));
  await sendAndConfirmTransaction(connection, tx, [fromKp]);
  console.log(`platform: topped up ${toPk.toBase58().slice(0, 6)}… with ${(lamports / LAMPORTS_PER_SOL).toFixed(3)} SOL`);
  return true;
}

/** Create one platform if missing. Returns its id or null. */
async function ensureOne({ label, admin, creatorFeeRate, claimWallet }) {
  const s = await loadSdk();
  const pid = CFG.IS_MAINNET ? s.LAUNCHPAD_PROGRAM : s.DEVNET_PROGRAM_ID.LAUNCHPAD_PROGRAM;
  const derived = s.getPdaPlatformId(pid, admin.publicKey).publicKey;

  if (await connection.getAccountInfo(derived)) {
    console.log(`platform[${label}]: live — ${derived.toBase58()}`);
    return derived;
  }

  let balance = await connection.getBalance(admin.publicKey);
  const NEED = 0.045 * LAMPORTS_PER_SOL;
  if (balance < NEED) {
    /* devnet: try the faucet; both networks: try a top-up from the pad admin */
    if (!CFG.IS_MAINNET) {
      try {
        const sig = await connection.requestAirdrop(admin.publicKey, 1 * LAMPORTS_PER_SOL);
        await connection.confirmTransaction(sig, "confirmed");
        balance = await connection.getBalance(admin.publicKey);
      } catch { console.log(`platform[${label}]: devnet airdrop failed`); }
    }
    const pad = padAdmin();
    if (balance < NEED && pad && !pad.publicKey.equals(admin.publicKey)) {
      try {
        if (await topUpFrom(pad, admin.publicKey, Math.ceil(NEED + 0.02 * LAMPORTS_PER_SOL))) {
          balance = await connection.getBalance(admin.publicKey);
        }
      } catch (e) { console.log(`platform[${label}]: top-up failed:`, e.message); }
    }
  }
  if (balance < 0.03 * LAMPORTS_PER_SOL) {
    console.log(`platform[${label}]: NOT created — fund ${admin.publicKey.toBase58()} with ~0.05 SOL (${CFG.NETWORK}).`);
    return null;
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
  const cpmmProgram = CFG.IS_MAINNET ? s.CREATE_CPMM_POOL_PROGRAM : s.DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM;
  const cpConfigId = await resolveCpConfig(s, cpmmProgram);
  console.log(`platform[${label}]: using cpConfigId ${cpConfigId.toBase58()}`);

  const wallet = claimWallet || admin.publicKey;
  const { execute } = await raydium.launchpad.createPlatformConfig({
    programId: pid,
    platformAdmin: admin.publicKey,
    platformClaimFeeWallet: wallet,
    platformLockNftWallet: wallet,
    platformVestingWallet: wallet,
    cpConfigId,
    migrateCpLockNftScale: {
      platformScale: new BN(Number(process.env.PLATFORM_SCALE || 1_000_000)),
      creatorScale: new BN(0), // program rule: must be 0 at creation
      burnScale: new BN(Number(process.env.BURN_SCALE || 0)),
    },
    transferFeeExtensionAuth: wallet,
    creatorFeeRate: new BN(creatorFeeRate),
    feeRate: new BN(Number(process.env.PLATFORM_FEE_RATE || 0)), // 0% on the curve — the pledge
    name: (process.env.PLATFORM_NAME || "index") + (label === "main" ? " main" : ""),
    web: process.env.PLATFORM_WEB || "https://launchonindex.fun",
    img: process.env.PLATFORM_IMG || "https://launchonindex.fun",
    txVersion: TxVersion.V0,
    computeBudgetConfig: { units: 400_000, microLamports: 50_000 },
  });
  const res = await execute({ sendAndConfirm: true });
  const txId = res?.txId || (Array.isArray(res?.txIds) ? res.txIds[0] : "");
  console.log(`platform[${label}]: CREATED ${derived.toBase58()} (tx ${txId}) — creatorFeeRate=${creatorFeeRate}`);
  return derived;
}

async function ensurePlatform() {
  const pad = padAdmin();
  if (pad && !state.pad.ensured) {
    const id = await ensureOne({
      label: "pad",
      admin: pad,
      creatorFeeRate: Number(process.env.CREATOR_FEE_RATE ?? 2_500), // 0.25% to creators
    });
    if (id) { state.pad.id = id; state.pad.ensured = true; }
  } else if (!pad) {
    console.log("platform: no PLATFORM_ADMIN_SECRET — launches use Raydium's default platform");
  }

  const main = mainAdmin();
  if (main && !state.main.ensured) {
    const id = await ensureOne({
      label: "main",
      admin: main,
      creatorFeeRate: 0, // $INDEX: nothing to a creator — the whole 1% flows to the platform side
      claimWallet: pad ? pad.publicKey : null, // all revenue lands in the pad admin wallet
    });
    if (id) { state.main.id = id; state.main.ensured = true; }
  }
  return platformId();
}

module.exports = {
  ensurePlatform,
  platformId,
  mainPlatformId,
  adminPubkey: () => padAdmin()?.publicKey?.toBase58() || null,
  mainAdminPubkey: () => mainAdmin()?.publicKey?.toBase58() || null,
};
