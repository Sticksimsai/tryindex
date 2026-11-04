"use strict";
const express = require("express");
const cors = require("cors");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const CFG = require("./config");
const store = require("./store");
const { prepareLaunch, submitLaunch } = require("./launch");

const app = express();
app.use(cors());
app.use(express.json({ limit: "3mb" }));

const META_DIR = path.join(__dirname, "data", "meta");
fs.mkdirSync(META_DIR, { recursive: true });

/* in-memory map of prepared (unsubmitted) launches: mint -> details */
const pending = new Map();

app.get("/api/config", (_req, res) => {
  res.json({
    ok: true,
    network: CFG.NETWORK,
    maxDevBuyPct: CFG.MAX_DEV_BUY_PCT,
    solPerPct: CFG.SOL_PER_PCT,
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
      const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(imageBase64);
      if (!m) return res.status(400).json({ error: "bad image" });
      const buf = Buffer.from(m[2], "base64");
      if (buf.length > 2_000_000) return res.status(400).json({ error: "image too large (2MB max)" });
      fs.writeFileSync(path.join(META_DIR, `${id}.img`), buf);
      imageUri = `${CFG.PUBLIC_URL}/meta/${id}.img`;
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
});
