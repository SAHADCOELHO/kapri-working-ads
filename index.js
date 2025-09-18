
import express from 'express';
import cors from 'cors';
import path from 'path';
import 'dotenv/config';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

function inferCategory(model, fallback='iPhones'){
  const m = String(model).toLowerCase();
  if (m.includes('ipad')) return 'iPads';
  if (m.includes('macbook') || m.includes('mac')) return 'MacBooks';
  if (m.includes('watch')) return 'Apple Watch';
  return fallback;
}

app.use(cors());
app.use(express.json());

// Static site (serves /web)
);

const DATA_XLSX = path.join(__dirname, 'data', 'allo-kapri-catalog-SPLIT.xlsx');
const COLOR_MODS_PATH = path.join(__dirname, 'config', 'color-modifiers.json');

function normModel(m){
  if(!m) return "";
  return String(m).trim()
    .replace(/\s+/g,' ')
    .replace(/^iphone/i, 'iPhone') // keep brand case for display
}

function toIdFromModel(m){
  return String(m).toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'');
}

function safeNumber(v){
  if(typeof v === 'number') return v;
  if(!v) return null;
  const s = String(v).replace(/[^\d.,-]/g,'').replace('.','').replace(',','.');
  const n = Number(s);
  return isNaN(n)? null : n;
}

function loadColorMods(){
  try{
    const raw = fs.readFileSync(COLOR_MODS_PATH, 'utf8');
    return JSON.parse(raw);
  }catch(e){
    return { gold:0.08, default:0.05, black:0 };
  }
}

function detectColorKeyFromHex(hex){
  if(!hex) return 'default';
  const h = String(hex).toLowerCase();
  if(h.includes('d4af37')) return 'gold';
  if(h.includes('ffd700')) return 'gold';
  if(h.includes('aaa')||h.includes('silver')) return 'silver';
  if(h.includes('000')||h.includes('0b1020')) return 'black';
  if(h.includes('e5e7eb')||h.includes('fff')) return 'white';
  if(h.includes('1d4ed8')||h.includes('00f')||h.includes('1e40af')) return 'blue';
  if(h.includes('dc2626')||h.includes('f00')) return 'red';
  if(h.includes('16a34a')||h.includes('0f0')) return 'green';
  if(h.includes('949494')||h.includes('808080')) return 'titanium';
  return 'default';
}

function loadWorkbook(){
  if(!fs.existsSync(DATA_XLSX)) return null;
  return XLSX.readFile(DATA_XLSX);
}

function sheetToJson(wb, name){
  const ws = wb.Sheets[name];
  if(!ws) return [];
  return XLSX.utils.sheet_to_json(ws, { defval: null });
}

// Build catalog from XLSX (expects sheets prices_usados / prices_novos, optional colors, storages, products)
function buildCatalog(wb, market='AO'){
  const used = sheetToJson(wb, 'prices_usados');
  const novo = sheetToJson(wb, 'prices_novos');
  const colorsSheet = sheetToJson(wb, 'colors');
  const storagesSheet = sheetToJson(wb, 'storages');
  const productsSheet = sheetToJson(wb, 'products');

  // Normalize rows
  const normRow = (r, cond) => {
    const model = normModel(r.model || r.product || r.product_name || r.product_id || r.modelo);
    const id = r.product_id ? String(r.product_id) : toIdFromModel(model);
    const storage = Number(r.storage_gb || r.gb || r.storage || r.armazenamento);
    const mkt = (r.market || r.mercado || '').toString().toUpperCase() || market;
    // price may be in price, price_kz, kz, etc.
    let price = safeNumber(r.price || r.price_kz || r.kzs || r.preco || r.valor);
    const currency = (r.currency || r.moeda || (mkt==='AO'?'AOA':'USD')).toString().toUpperCase();
    const disponibilidade = (r.disponibilidade || r.Disponibilidade || r.DISPONIBILIDADE || '').toString().trim();
    return { id, model, storage_gb: storage, market: mkt, condition: cond, price, currency, disponibilidade };
  };

  const usedRows = used.map(r => normRow(r,'usado')).filter(r => r.model && r.price);
  const newRows  = novo.map(r => normRow(r,'novo')).filter(r => r.model && r.price);

  // Build map model -> base product record
  const byModel = new Map();
  function ensureProduct(row){
    if(!byModel.has(row.model)){
      // fallback rating/reviews
      const rating = 4 + Math.random()*1; // 4.0–5.0
      const reviews = Math.min(250, Math.floor(50 + Math.random()*200));
      // attach colors for iphones default palette
      let colors = ['#0b1020','#d4af37','#e5e7eb','#1d4ed8']; // black, gold, white/silver, blue
      // optional colors sheet override
      const cs = colorsSheet.filter(c => normModel(c.model||c.product_id||c.product) === row.model)
                             .map(c => c.color_hex || c.hex || c.color).filter(Boolean);
      if(cs.length) colors = cs.slice(0,4);
      // optional product image override
      let image = null;
      const ps = productsSheet.find(p => normModel(p.model||p.product_id||p.product) === row.model);
      if(ps && (ps.image||ps.img)) image = ps.image||ps.img;
      byModel.set(row.model, {
        id: row.id,
        model: row.model,
        type: row.model.toLowerCase().includes('iphone') ? 'iphone' :
              row.model.toLowerCase().includes('mac') ? 'macbook' :
              row.model.toLowerCase().includes('ipad') ? 'ipad' : 'acessorio',
        rating: Math.round(rating*10)/10,
        reviews,
        colors,
        image
      });
    }
  }

  [...usedRows, ...newRows].forEach(ensureProduct);

  // Build variants map
  const variants = {};
  function addVar(r){
    const key = r.model + '|' + r.condition + '|' + r.storage_gb + '|' + r.market;
    variants[key] = {price: r.price, currency: r.currency};
  }
  usedRows.forEach(addVar);
  newRows.forEach(addVar);

  // For each product, compute available storages per condition for market
  const products = [];
  for(const p of byModel.values()){
    const storSetUsed = new Set();
    const storSetNew = new Set();
    Object.keys(variants).forEach(k => {
      const [m,c,gb,mkt] = k.split('|');
      if(m===p.model && mkt===market){
        if(c==='usado') storSetUsed.add(Number(gb));
        if(c==='novo')  storSetNew.add(Number(gb));
      }
    });
    // only include product if has at least one variant for market
    if(storSetUsed.size===0 && storSetNew.size===0) continue;
    products.push({
      id: p.id,
      model: p.model,
      type: p.type,
      rating: p.rating,
      reviews: p.reviews,
      colors: p.colors.slice(0,4),
      image: p.image || `/public/products/${p.id}.png`,
      storages: {
        usado: Array.from(storSetUsed).sort((a,b)=>a-b),
        novo:  Array.from(storSetNew).sort((a,b)=>a-b)
      }
    });
  }

  return { products, variants };
}

app.get('/api/health', (req,res)=>{
  res.type('text').send('Allô Kapri API OK. Use GET /api/catalog?market=AO|US');
});

app.get('/api/catalog', (req,res)=>{
  try{
    const market = String(req.query.market||'AO').toUpperCase();
    const city = String(req.query.city||'Luanda').toLowerCase();
    const wb = loadWorkbook();
    if(!wb) return res.status(500).json({error:'XLSX not found'});
    const catalog = buildCatalog(wb, market);
    const colorMods = loadColorMods();
    res.json({ market, colorMods, ...catalog });
  }catch(e){
    console.error(e);
    res.status(500).json({error:'failed', details:String(e)});
  }
});

const PORT = process.env.PORT || 5050;



async function postKommo(payload){
  try{
    const url = process.env.KOMMO_WEBHOOK_URL || '';
    if(!url) return { ok:false, reason:'no_webhook' };
    const r = await fetch(url, {
      method:'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    return { ok: r.ok, status: r.status };
  }catch(e){
    console.error('kommo post error', e);
    return { ok:false, reason:String(e) };
  }
}

// Featured products endpoint
app.get('/api/featured', (req, res) => {
  try {
    const market = String(req.query.market||'AO').toUpperCase();
    const city = String(req.query.city||'Luanda').toLowerCase();
    const wb = loadWorkbook();
    if(!wb) return res.status(500).json({error:'XLSX not found'});
    const catalog = buildCatalog(wb, market);

    // Read optional list of preferred featured models
    let preferred = [];
    try {
      const fp = path.join(__dirname, 'config', 'featured.json');
      if (fs.existsSync(fp)) {
        const raw = JSON.parse(fs.readFileSync(fp,'utf8'));
        preferred = Array.isArray(raw.models) ? raw.models.filter(Boolean) : [];
      }
    } catch(e){ /* ignore */ }

    // Helper: compute minimal price (any condition) for AO market
    function minPriceForModel(model){
      let min = null, currency = 'AOA';
      Object.keys(catalog.variants).forEach(k=>{
        const [m,cond,gb,mkt] = k.split('|');
        if(m===model && mkt===market){
          const v = catalog.variants[k];
          if(v && typeof v.price==='number'){
            if(min==null || v.price<min){ min=v.price; currency=v.currency; }
          }
        }
      });
      return {min, currency};
    }

    // Prepare product list with prices and image absolute URLs
    const modelsAvailable = new Set();
    // determine which models have disponibilidade containing the city
    Object.entries(catalog.variants).forEach(([k,v])=>{
      // We need original rows to check disponibilidade; as a workaround, rebuild from sheets
    });
    // Fallback: infer from products + sheets again
    try{
      const wb2 = loadWorkbook();
      const getSheet = (name)=>{ try{ return XLSX.utils.sheet_to_json(wb2.Sheets[name]||{}, {defval:null}); }catch(e){ return []; } };
      const used = getSheet('prices_usados');
      const novo = getSheet('prices_novos');
      [...used, ...novo].forEach(r=>{
        const model = normModel(r.model||r.Model||'');
        const disponibilidade = String(r.disponibilidade||r.Disponibilidade||'').toLowerCase();
        if(model && disponibilidade.includes(city)) modelsAvailable.add(model);
      });
    }catch(e){ /* ignore */ }

    const baseUrl = (req.protocol + '://' + req.get('host')).replace(/\/$/, '');
    const items = catalog.products.filter(p=>modelsAvailable.has(p.model)).map(p=>{
      const {min, currency} = minPriceForModel(p.model);
      return {
        id: p.id,
        model: p.model,
        image: p.image?.startsWith('/')
          ? (baseUrl + p.image)
          : p.image,
        min_price: min,
        currency
      };
    }).filter(it => it.min_price != null);

    // If preferred list provided, order by it; else fallback to first N
    const mapByModel = new Map(items.map(it=>[it.model, it]));
    const ordered = [];
    preferred.forEach(m=>{ if(mapByModel.has(m)) ordered.push(mapByModel.get(m)); });
    items.forEach(it=>{ if(!ordered.includes(it)) ordered.push(it); });

    const count = Math.max(1, Math.min(20, Number(req.query.count)||8));
    return res.json({ market, count, items: ordered.slice(0, count) });
  } catch(e){
    console.error('featured error', e);
    return res.status(500).json({error:'failed_featured', details:String(e)});
  }
});



// Subscription endpoint: append emails to CSV
// Subscription endpoint: name + email + phone
// Subscription endpoint: name + email + phone
app.post('/api/subscribe', (req,res)=>{
  try{
    const name  = String((req.body?.name||'')).trim();
    const email = String((req.body?.email||'')).trim().toLowerCase();
    const phone = String((req.body?.phone||'')).trim();
    if(!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
      return res.status(400).json({error:'invalid_email'});
    }
    const outPath = path.join(__dirname,'data','subscribers.csv');
    const hdr = (!fs.existsSync(outPath));
    const row = [new Date().toISOString(), name, email, phone, (req.get('user-agent')||'')];
    const line = (hdr ? 'timestamp,name,email,phone,user_agent\n' : '') + row.map(v=>String(v).replace(/"/g,'""')).join(',') + '\n';
    fs.appendFileSync(outPath, line, 'utf8');
    return res.json({ok:true});
  }catch(e){
    console.error('subscribe error', e);
    return res.status(500).json({error:'failed_sub', details:String(e)});
  }
});

app.listen(PORT, ()=>{
  console.log(`Allô Kapri API + Web on http://127.0.0.1:${PORT}`);
});
