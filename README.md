# Block Zero — landing page

Stealth-only meme launchpad on Solana (built on Raydium LaunchLab).
Single static page, no build step, no dependencies beyond Google Fonts.

## Deploy on Render

1. Push this folder to a GitHub repo (just `index.html` is enough).
2. On Render: **New → Static Site** → connect the repo.
3. Settings:
   - **Build command:** *(leave empty)*
   - **Publish directory:** `.`
4. Deploy. Done — Render serves `index.html` at the root.

(Any static host works the same way: Cloudflare Pages, Vercel, GitHub Pages.)

## Editing

- **Launch cards** — edit the `launches` array at the top of the `<script>` block (name, ticker, mcap, holders, banner hues). Swap it for a live feed at integration time.
- **Basket weights** — edit the `basket` array; the donut segments and the holdings list both sync from it automatically.
- **Brand** — the name appears in the `<title>`, the two `.logo` elements, and the hero copy. Colors live in the `:root` tokens at the top of `<style>`.
- **Rotation countdown** — currently counts to Mondays 00:00 UTC; change `nextMonday()` if the rebalance cadence changes.

## Notes

- "Connect wallet" / "Launch a token" currently show a toast; wire them to your wallet adapter + launch API when the backend exists.
- All tokens and figures on the page are example data, labelled as such in the footer.

## Launch engine (server/)

Node/Express service that serves the site **and** runs real sealed launches on Raydium LaunchLab.

- `POST /api/launch/prepare` — generates the mint keypair server-side (the sealed CA), hosts metadata, builds the atomic create + dev-buy transaction via `raydium.launchpad.createLaunchpad` (createOnly:false), partial-signs with the mint, returns unsigned-for-creator txs
- `POST /api/launch/submit` — submits the creator-signed transactions, records the launch
- `GET /api/launches[/:mint]` — launch feed for the site
- `GET /meta/*` — token metadata + images for wallets

### Environment

| var | default | notes |
|---|---|---|
| `NETWORK` | `devnet` | set `mainnet` to go live |
| `RPC_URL` | public devnet/mainnet | use a paid RPC (Helius/Triton) for mainnet |
| `PLATFORM_ID` | Raydium default | set to the index PlatformConfig id once created |
| `MAX_DEV_BUY_PCT` | 3 | the product rule |
| `SOL_PER_PCT` | 0.8 | SOL cost per 1% at the curve floor |

### Mainnet checklist
1. Test full launches on devnet (free SOL from faucet)
2. Create the index PlatformConfig on-chain (fee wallet, 0% curve fee, curve rules) → set `PLATFORM_ID`
3. Paid RPC into `RPC_URL`, `NETWORK=mainnet`
4. v2 hardening: Jito bundle submission, escrow blind-launch mode, Postgres store, rate limiting
