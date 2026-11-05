#!/usr/bin/env node
"use strict";
/* Admin sweep — run BY THE OWNER from the Render shell (env already set):
 *
 *   node server/sweep.js <DESTINATION_WALLET> <AMOUNT_SOL | all>
 *
 * Sends SOL from the platform admin wallet (PLATFORM_ADMIN_SECRET) to the
 * destination. "all" leaves 0.05 SOL behind for rent + future fee claims.
 * Prints the balance and asks nothing else — double-check the destination. */

const { Connection, Keypair, PublicKey, SystemProgram, Transaction,
        sendAndConfirmTransaction, LAMPORTS_PER_SOL } = require("@solana/web3.js");

(async () => {
  const [dest, amountArg] = process.argv.slice(2);
  if (!dest || !amountArg) {
    console.log("usage: node server/sweep.js <DESTINATION_WALLET> <AMOUNT_SOL | all>");
    process.exit(1);
  }
  const raw = process.env.PLATFORM_ADMIN_SECRET;
  if (!raw) { console.error("PLATFORM_ADMIN_SECRET not set"); process.exit(1); }
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  const to = new PublicKey(dest);
  const conn = new Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");

  const bal = await conn.getBalance(kp.publicKey);
  console.log(`from ${kp.publicKey.toBase58()}`);
  console.log(`balance: ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  const KEEP = 0.05 * LAMPORTS_PER_SOL; // rent + future claim txs
  const lamports = amountArg === "all"
    ? bal - KEEP
    : Math.round(Number(amountArg) * LAMPORTS_PER_SOL);
  if (lamports <= 0 || lamports > bal - 5000) {
    console.error("amount out of range for current balance"); process.exit(1);
  }

  console.log(`sending ${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL -> ${to.toBase58()}`);
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: kp.publicKey, toPubkey: to, lamports,
  }));
  const sig = await sendAndConfirmTransaction(conn, tx, [kp]);
  console.log("done:", sig);
  console.log(`remaining: ${((await conn.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
})().catch((e) => { console.error("sweep failed:", e.message); process.exit(1); });
