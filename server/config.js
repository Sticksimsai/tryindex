"use strict";
/* Central config — flip NETWORK to "mainnet" (plus a mainnet RPC_URL) to go live.
   Everything else is identical between the two networks. */

const NETWORK = process.env.NETWORK === "mainnet" ? "mainnet" : "devnet";

module.exports = {
  NETWORK,
  IS_MAINNET: NETWORK === "mainnet",

  RPC_URL:
    process.env.RPC_URL ||
    (NETWORK === "mainnet"
      ? "https://api.mainnet-beta.solana.com"
      : "https://api.devnet.solana.com"),

  /* Public base URL of this service (used for metadata URIs shown in wallets).
     Render sets RENDER_EXTERNAL_URL automatically. */
  PUBLIC_URL: process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:3000",

  PORT: Number(process.env.PORT || 3000),

  /* Launch rules (the product): single dev buy, hard-capped. */
  MAX_DEV_BUY_PCT: Number(process.env.MAX_DEV_BUY_PCT || 3),
  /* SOL cost per 1% of supply on the launch curve. With Raydium's default
     bonding config (85 SOL raise, 1B supply) ~0.8 SOL buys ~1% at the floor.
     TODO: replace with exact Curve math once our own platform config (with the
     $20k-floor curve) is live; until then this constant is the cap. */
  SOL_PER_PCT: Number(process.env.SOL_PER_PCT || 0.8),

  /* Raydium LaunchLab platform id this launchpad launches under.
     Defaults to Raydium's public platform. Replace with OUR platform id once
     the index PlatformConfig is created on-chain (that is what turns on the
     0%-under-$100k fee story + curve rules). */
  PLATFORM_ID: process.env.PLATFORM_ID || "",

  /* Max symbol length enforced by LaunchLab metadata */
  MAX_SYMBOL: 10,
  MAX_NAME: 32,
};
