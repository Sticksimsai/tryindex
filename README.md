# tryindex.fun

Stealth-only meme launchpad on Solana, built on Raydium LaunchLab.
Static site — no build step, fonts embedded, no dependencies beyond Google Fonts.

## Pages

- `index.html` — landing: hero, live launch marquee, the four rules, The Index (ring, drop calculator, rotation history)
- `docs.html` — how a launch works, six animated steps + FAQ
- `stats.html` — dashboard: given away, fee split, live rewards feed, wallet leaderboard, this week's Index

## Deploy on Render

New → Static Site → connect this repo:
- Build command: *(empty)*
- Publish directory: `.`

## Editing

- Launch cards: the `launches` array in `index.html`'s script — swap for a live feed at integration
- Index weights: `tokens` array (ring) and `IDX` (stats page)
- Calculator economics: `POT` and `SUPPLY` constants in `index.html`
- Brand colors: the `:root` tokens at the top of each page's `<style>`

All figures on the site are example data until the API is wired in.
