"use strict";
const express = require("express");
const cors = require("cors");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const CFG = require("./config");
const store = require("./store");
const { prepareLaunch, submitLaunch, curveParams, solUsd } = require("./launch");
const platform = require("./platform");
const indexer = require("./indexer");
const creatorFees = require("./creatorfees");

const app = express();
app.use(cors());
app.use(express.json({ limit: "8mb" }));

const META_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, "data"), "meta");
fs.mkdirSync(META_DIR, { recursive: true });

/* in-memory map of prepared (unsubmitted) launches: mint -> details */
const pending = new Map();

app.get("/api/config", async (_req, res) => {
  const pfid = platform.platformId();
  let curve = null;
  try { curve = curveParams(await solUsd()); } catch {}
  res.json({
    ok: true,
    network: CFG.NETWORK,
    maxDevBuyPct: CFG.MAX_DEV_BUY_PCT,
    solPerPct: curve ? Math.round(curve.solPerPct * 100) / 100 : CFG.SOL_PER_PCT,
    curve: curve ? { entryMcapUsd: curve.entryMcapUsd, gradMcapUsd: curve.gradMcapUsd, raiseSol: Math.round(curve.raiseSol), sellPct: Math.round(curve.sellPct*10)/10, solUsd: curve.solPx } : null,
    platformId: pfid ? pfid.toBase58() : null,
    platformAdmin: platform.adminPubkey(),
    mainPlatformId: platform.mainPlatformId() ? platform.mainPlatformId().toBase58() : null,
  });
});

/* -------- metadata hosting (wallet-visible token metadata) -------- */
app.get("/meta/:file", (req, res) => {
  const f = path.join(META_DIR, path.basename(req.params.file));
  if (!fs.existsSync(f)) return res.status(404).json({ error: "not found" });
  res.sendFile(f);
});

/* -------- launch flow -------- */
app.post("/api/launch/prepare", async (req, res) => {
  try {
    const { creator, name, symbol, twitter, devBuyPct, imageBase64 } = req.body || {};
    if (!creator || !name || !symbol) {
      return res.status(400).json({ error: "creator, name and symbol are required" });
    }
    const clean = String(symbol).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CFG.MAX_SYMBOL);
    if (!clean) return res.status(400).json({ error: "bad ticker" });

    /* stage image + metadata under a temp id; renamed to the mint after prepare */
    const id = crypto.randomBytes(8).toString("hex");
    let imageUri = "";
    if (imageBase64) {
      const m = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/.exec(imageBase64);
      if (!m) return res.status(400).json({ error: "bad image — PNG, JPG, WEBP or GIF" });
      const buf = Buffer.from(m[2], "base64");
      if (buf.length > 5_000_000) return res.status(400).json({ error: "image too large (5MB max)" });
      const ext = m[1] === "jpeg" ? "jpg" : m[1];
      fs.writeFileSync(path.join(META_DIR, `${id}.${ext}`), buf);
      imageUri = `${CFG.PUBLIC_URL}/meta/${id}.${ext}`;
    }
    const meta = {
      name: String(name).slice(0, CFG.MAX_NAME),
      symbol: clean,
      description: `${name} — launched sealed on index.fun. Website locked to the live token page.`,
      image: imageUri,
      external_url: "", // filled with the token page after prepare
      extensions: { twitter: twitter || "" },
    };
    fs.writeFileSync(path.join(META_DIR, `${id}.json`), JSON.stringify(meta));
    const uri = `${CFG.PUBLIC_URL}/meta/${id}.json`;

    const out = await prepareLaunch({ creator, name, symbol: clean, uri, devBuyPct });

    /* lock the website to the token page, now that the CA exists */
    meta.external_url = `${CFG.PUBLIC_URL}/token?mint=${out.mint}`;
    fs.writeFileSync(path.join(META_DIR, `${id}.json`), JSON.stringify(meta));

    pending.set(out.mint, {
      mint: out.mint,
      poolId: out.poolId,
      name: meta.name,
      symbol: clean,
      twitter: twitter || "",
      image: imageUri,
      metaId: id,
      devBuyPct: out.devBuyPct,
      creator,
      network: out.network,
      preparedAt: Date.now(),
    });

    res.json(out);
  } catch (e) {
    console.error("prepare failed:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/launch/submit", async (req, res) => {
  try {
    const { mint, txs } = req.body || {};
    const p = pending.get(mint);
    if (!p) return res.status(400).json({ error: "unknown or expired launch — prepare again" });
    const { signatures } = await submitLaunch({ txs });
    pending.delete(mint);
    const entry = { ...p, signatures, launchedAt: Date.now(), status: "live" };
    store.upsert(entry);
    res.json({ ok: true, mint, signatures, token: entry });
  } catch (e) {
    console.error("submit failed:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/launches", (_req, res) => res.json(store.list()));

/* -------- creator fees: accrued balance + claim (creator signs) -------- */
app.get("/api/creator-fees/:mint", async (req, res) => {
  try {
    const t = store.get(req.params.mint);
    if (!t) return res.status(404).json({ error: "not found" });
    const out = await creatorFees.feesFor(t.creator);
    /* estimate of this token's contribution: creatorFeeRate x its curve volume */
    const rate = Number(process.env.CREATOR_FEE_RATE ?? 2500) / 1e6;
    out.thisTokenVolSol = t.vol24Sol || 0;
    out.estFromThisTokenSol = Math.round((t.vol24Sol || 0) * rate * 1e6) / 1e6;
    out.feeRatePct = rate * 100;
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});
app.post("/api/creator-fees/claim/prepare", async (req, res) => {
  try {
    const { creator } = req.body || {};
    if (!creator) return res.status(400).json({ error: "creator required" });
    const bal = await creatorFees.feesFor(creator);
    if (!bal.claimableSol) return res.status(400).json({ error: "nothing to claim yet" });
    const out = await creatorFees.prepareClaim(creator);
    res.json({ ok: true, claimableSol: bal.claimableSol, ...out });
  } catch (e) {
    console.error("claim prepare failed:", e.message);
    res.status(500).json({ error: String(e.message || e) });
  }
});
app.post("/api/creator-fees/claim/submit", async (req, res) => {
  try {
    const { signatures } = await creatorFees.submitClaim((req.body || {}).txs);
    res.json({ ok: true, signatures });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/trades/:mint", async (req, res) => {
  const t = store.get(req.params.mint);
  if (!t) return res.status(404).json({ error: "not found" });
  let px = 0;
  try { px = await solUsd(); } catch {}
  res.json({
    ok: true,
    trades: indexer.tradesFor(req.params.mint, 500),
    solUsd: px,
    stats: {
      mcapSol: t.mcapSol || null, mcapUsd: t.mcapUsd || null,
      vol24Sol: t.vol24Sol || 0, curveSol: t.curveSol || 0,
      traders: t.traders || 0, status: t.status || "live",
      lastTradeAt: t.lastTradeAt || null,
    },
  });
});
app.get("/api/launches/:mint", (req, res) => {
  const t = store.get(req.params.mint);
  if (!t) return res.status(404).json({ error: "not found" });
  res.json(t);
});

/* -------- static site -------- */
/* vanity token links: /t/<mint-or-ticker> -> the live token page */
app.get("/t/:q", (req, res) => {
  const q = String(req.params.q);
  const t = store.get(q) || store.list().find((l) => l.symbol === q.toUpperCase());
  res.redirect(t ? `/token?mint=${t.mint}` : "/tokens");
});

/* clean URLs: /docs -> docs.html etc. */
app.use(express.static(path.join(__dirname, ".."), { extensions: ["html"] }));

app.listen(CFG.PORT, () => {
  console.log(`index.fun engine up on :${CFG.PORT} — network=${CFG.NETWORK} rpc=${CFG.RPC_URL}`);
  platform.ensurePlatform().catch((e) => {
    console.error("platform setup failed:", e && (e.message || e));
    if (e && e.logs) console.error("tx logs:\n" + e.logs.join("\n"));
    if (e && e.stack) console.error(e.stack.split("\n").slice(0, 6).join("\n"));
  });
  indexer.start();
});
