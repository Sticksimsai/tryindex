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

  const buyLamports = Math.floor(pct * CFG.SOL_PER_PCT * LAMPORTS);

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
  const pfid = platform.platformId();
  if (pfid) params.platformId = pfid;

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

module.exports = { prepareLaunch, submitLaunch, connection };
