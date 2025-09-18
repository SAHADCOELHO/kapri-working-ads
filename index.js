// backend/index.js  (CommonJS)

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const app = express();

// CORS
const ORIGIN = process.env.CORS_ORIGIN || '*';
app.use(cors({ origin: ORIGIN }));

// Healthcheck
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Util: carrega catálogo do Excel
function loadCatalog() {
  const excelPath = path.join(__dirname, 'data', 'allo-kapri-catalog-SPLIT.xlsx');
  if (!fs.existsSync(excelPath)) {
    console.warn('[catalog] Excel não encontrado em:', excelPath);
    return [];
  }
  const wb = XLSX.readFile(excelPath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  // Ajuste simples: garanta um array de objetos com campos básicos.
  // (Mantenha sua lógica original aqui se você tinha algo mais elaborado)
  return rows;
}

app.get('/api/catalog', (_req, res) => {
  try {
    const data = loadCatalog();
    res.json(data);
  } catch (e) {
    console.error('[catalog] erro:', e);
    res.status(500).json({ error: 'failed_to_load_catalog' });
  }
});

// Porta
const PORT = process.env.PORT || 5050;
app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
