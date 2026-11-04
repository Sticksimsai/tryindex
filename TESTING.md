# Trial launches on devnet → mainnet

The engine at **https://tryindex-engine.onrender.com** is running in `NETWORK=devnet` mode.
Everything below is real transactions against the real LaunchLab devnet program — just with free SOL.

## 1. Set up a test wallet (2 min)

1. In Phantom: Settings → Developer Settings → turn **Testnet Mode** ON (this switches it to devnet)
2. Get free devnet SOL: https://faucet.solana.com — paste your address, request 2–5 SOL
   (if the faucet is dry: `solana airdrop 2 <ADDRESS> --url devnet` from any machine with the Solana CLI)

## 2. Run a trial launch

1. Open https://tryindex-engine.onrender.com/create
   (free Render plan sleeps when idle — first load can take ~30s)
2. You should see the toast: **"Engine connected — devnet mode"**. If not, the API didn't load; hard-refresh.
3. Connect wallet (it must be in Testnet/devnet mode)
4. Fill name, ticker, upload an image, set a dev buy (try 1%, ≈0.8 SOL)
5. **Launch sealed** → approve in the wallet → you land on `/token?mint=<CA>`

## 3. What to verify

- [ ] Token page shows your name, image, and the CA linking to Solscan (devnet)
- [ ] On Solscan: the create and the dev buy are in the transaction, dev wallet holds ~1% of supply
- [ ] `/tokens` dashboard shows the launch at the top with "Just launched · devnet"
- [ ] `/t/<TICKER>` redirects to the token page (the locked website link)
- [ ] Metadata renders in the wallet (name/symbol/image on the token)
- [ ] A second buy from another devnet wallet works on Raydium devnet (optional)
- [ ] Launch with 0% dev buy also works
- [ ] Launch with 3% dev buy is capped correctly (~2.4 SOL)

## 4. Known trial-mode limits (fine for devnet, fix before mainnet)

- Launches run under **Raydium's default platform id** → their standard curve fee applies.
  The "0% under $100k" story needs our own PlatformConfig on-chain (next build step).
- Curve is Raydium's default (~$4k start, 85 SOL raise), not the $20k-floor custom curve —
  that also comes with our own platform/config.
- Launch store is a JSON file on the service disk — wiped on redeploy (fine for trials).
- Free Render plan cold-starts; upgrade to Starter ($7/mo) before real traffic.

## 5. Mainnet switch (when trials pass)

On the **tryindex-engine** service in Render → Environment:

| var | value |
|---|---|
| `NETWORK` | `mainnet` |
| `RPC_URL` | a paid RPC endpoint (Helius / Triton / QuickNode) — public mainnet RPC will rate-limit |
| `PUBLIC_URL` | `https://launchonindex.fun` (once the domain is attached) |
| `PLATFORM_ID` | the index PlatformConfig id (after we create it on-chain) |

Then: attach `launchonindex.fun` to the engine service (Settings → Custom Domains),
switch Phantom back to mainnet, and do one small real launch yourself before announcing.

**Strong recommendation:** don't market "0% fees" or "$20k floor" until `PLATFORM_ID` is ours —
until then those are the defaults of Raydium's platform, not our rules.
