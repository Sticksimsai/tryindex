"use strict";
/* Creator fee sweep — reads a creator's accrued LaunchLab fees and builds the
   claim transaction for their wallet to sign (same creator-signs pattern as
   launches; the engine never holds creator keys).

   On LaunchLab, curve-trade creator fees accrue into a per-creator vault PDA
   (seeds: [creator, mintB]) as wrapped SOL. One claim sweeps everything that
   creator has earned across their launches. */

const { Connection, PublicKey, VersionedTransaction } = require("@solana/web3.js");
const { NATIVE_MINT } = require("@solana/spl-token");
const CFG = require("./config");

const connection = new Connection(CFG.RPC_URL, "confirmed");

let sdkP;
async function loadSdk() {
  if (!sdkP) sdkP = import("@raydium-io/raydium-sdk-v2");
  return sdkP;
}
function programId(s) {
  return CFG.IS_MAINNET ? s.LAUNCHPAD_PROGRAM : s.DEVNET_PROGRAM_ID.LAUNCHPAD_PROGRAM;
}

/** Accrued, claimable creator fees for a wallet (SOL). */
async function feesFor(creator) {
  const s = await loadSdk();
  const pid = programId(s);
  const vault = s.getPdaCreatorVault(pid, new PublicKey(creator), NATIVE_MINT).publicKey;
  let sol = 0, exists = false;
  try {
    const bal = await connection.getTokenAccountBalance(vault, "confirmed");
    sol = Number(bal?.value?.uiAmount || 0);
    exists = true;
  } catch { /* vault not created yet -> nothing accrued */ }
  return { creator, vault: vault.toBase58(), claimableSol: sol, vaultExists: exists };
}

/** Build the unsigned claim tx for the creator's wallet. */
async function prepareClaim(creator) {
  const s = await loadSdk();
  const { Raydium, TxVersion } = s;
  const creatorPk = new PublicKey(creator);
  const raydium = await Raydium.load({
    owner: creatorPk,
    connection,
    cluster: CFG.IS_MAINNET ? "mainnet" : "devnet",
    disableFeatureCheck: true,
    disableLoadToken: true,
    blockhashCommitment: "confirmed",
  });
  const { transactions } = await raydium.launchpad.claimCreatorFee({
    programId: programId(s),
    mintB: NATIVE_MINT,
    txVersion: TxVersion.V0,
    computeBudgetConfig: { units: 300_000, microLamports: 50_000 },
  });
  const txs = (transactions || []).map((tx) => Buffer.from(tx.serialize()).toString("base64"));
  return { txs };
}

/** Relay a creator-signed claim tx. */
async function submitClaim(txs) {
  if (!Array.isArray(txs) || !txs.length || txs.length > 2) throw new Error("bad payload");
  const sigs = [];
  for (const b64 of txs) {
    const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    await connection.confirmTransaction(sig, "confirmed");
    sigs.push(sig);
  }
  return { signatures: sigs };
}

module.exports = { feesFor, prepareClaim, submitClaim };
