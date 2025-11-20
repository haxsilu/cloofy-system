// CLOOFY One-File Business System (Backend + Frontend)

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const PDFDocument = require('pdfkit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- MIDDLEWARE ----------
app.use(express.json());

// ---------- DB SETUP ----------
const dbPath = path.join(process.env.DB_PATH || __dirname, 'cloofy.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run("PRAGMA foreign_keys = ON");

  db.run(`
    CREATE TABLE IF NOT EXISTS ingredients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      unit TEXT NOT NULL,
      current_stock REAL NOT NULL,
      reorder_level REAL NOT NULL,
      unit_cost REAL NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price REAL NOT NULL,
      recipe_json TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      product_id INTEGER NOT NULL,
      qty INTEGER NOT NULL,
      total_price REAL NOT NULL,
      FOREIGN KEY(product_id) REFERENCES products(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS inventory_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      ingredient_id INTEGER NOT NULL,
      change REAL NOT NULL,
      reason TEXT,
      FOREIGN KEY(ingredient_id) REFERENCES ingredients(id)
    )
  `);

  // Seed CLOOFY data if empty
  db.get("SELECT COUNT(*) AS c FROM ingredients", (err, row) => {
    if (err) {
      console.error("Error checking ingredients:", err);
      return;
    }
    if (row.c === 0) {
      console.log("Seeding initial CLOOFY ingredients & products...");
      seedIngredientsAndProducts();
    }
  });
});

// ---------- PROMISE HELPERS ----------
const runAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });

const allAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });

const getAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });

// ---------- SEED DATA ----------
async function seedIngredientsAndProducts() {
  try {
    // grams for all weight-based items
    const ingredients = [
      // id 1
      { name: 'Cotton Candy Base', unit: 'g', current: 12000, reorder: 4000, cost: 3 },       // 3,000/kg
      // id 2
      { name: "Hershey's Chocolate Syrup", unit: 'g', current: 6000, reorder: 2000, cost: 3.82 },
      // id 3
      { name: "Dark Chocolate Chips", unit: 'g', current: 2000, reorder: 500, cost: 1.85 },
      // id 4
      { name: "Hershey's Strawberry Syrup", unit: 'g', current: 6000, reorder: 2000, cost: 4.41 },
      // id 5
      { name: "Strawberry Pebbles", unit: 'g', current: 2000, reorder: 500, cost: 2 },        // 2,000/kg
      // id 6
      { name: "Caramel Syrup", unit: 'g', current: 6000, reorder: 2000, cost: 5 },            // estimate
      // id 7
      { name: "Biscoff Crumbs", unit: 'g', current: 1750, reorder: 500, cost: 5 }             // 1,250/250g
    ];

    for (const ing of ingredients) {
      await runAsync(
        `INSERT INTO ingredients (name, unit, current_stock, reorder_level, unit_cost)
         VALUES (?, ?, ?, ?, ?)`,
        [ing.name, ing.unit, ing.current, ing.reorder, ing.cost]
      );
    }

    const products = [
      {
        name: 'Chocolate Drizzle Cloud',
        price: 300,
        recipe: [
          { ingredientId: 1, qty: 20 }, // 20g cotton candy
          { ingredientId: 2, qty: 10 }, // 10g choc syrup
          { ingredientId: 3, qty: 2 }   // 2g choc chips
        ]
      },
      {
        name: 'Strawberry Drizzle Cloud',
        price: 300,
        recipe: [
          { ingredientId: 1, qty: 20 }, // 20g cotton candy
          { ingredientId: 4, qty: 10 }, // 10g strawberry syrup
          { ingredientId: 5, qty: 2 }   // 2g pebbles
        ]
      },
      {
        name: 'Caramel Drizzle Cloud',
        price: 300,
        recipe: [
          { ingredientId: 1, qty: 20 }, // 20g cotton candy
          { ingredientId: 6, qty: 10 }, // 10g caramel syrup
          { ingredientId: 7, qty: 2 }   // 2g biscoff
        ]
      }
    ];

    for (const p of products) {
      await runAsync(
        `INSERT INTO products (name, price, recipe_json)
         VALUES (?, ?, ?)`,
        [p.name, p.price, JSON.stringify(p.recipe)]
      );
    }

    console.log("Seeding completed.");
  } catch (e) {
    console.error("Error during seeding:", e);
  }
}

// ---------- API: INGREDIENTS ----------
app.get('/api/ingredients', async (req, res) => {
  try {
    const ingredients = await allAsync('SELECT * FROM ingredients');
    res.json(ingredients);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch ingredients' });
  }
});

app.post('/api/ingredients', async (req, res) => {
  try {
    const { name, unit, current_stock, reorder_level, unit_cost } = req.body;
    const result = await runAsync(
      `INSERT INTO ingredients (name, unit, current_stock, reorder_level, unit_cost)
       VALUES (?, ?, ?, ?, ?)`,
      [name, unit, current_stock, reorder_level, unit_cost]
    );
    res.json({ id: result.lastID });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to create ingredient' });
  }
});

app.post('/api/ingredients/:id/adjust', async (req, res) => {
  try {
    const { change, reason } = req.body;
    const ing = await getAsync('SELECT * FROM ingredients WHERE id = ?', [req.params.id]);
    if (!ing) return res.status(404).json({ error: 'Ingredient not found' });

    const newStock = ing.current_stock + change;
    await runAsync(
      'UPDATE ingredients SET current_stock = ? WHERE id = ?',
      [newStock, req.params.id]
    );
    await runAsync(
      `INSERT INTO inventory_logs (date, ingredient_id, change, reason)
       VALUES (datetime('now'), ?, ?, ?)`,
      [req.params.id, change, reason || 'Manual adjust']
    );

    res.json({ success: true, newStock });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to adjust stock' });
  }
});

// ---------- API: PRODUCTS ----------
app.get('/api/products', async (req, res) => {
  try {
    const products = await allAsync('SELECT * FROM products');
    res.json(
      products.map(p => ({
        ...p,
        recipe: JSON.parse(p.recipe_json)
      }))
    );
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

app.post('/api/products', async (req, res) => {
  try {
    const { name, price, recipe } = req.body;
    const result = await runAsync(
      `INSERT INTO products (name, price, recipe_json)
       VALUES (?, ?, ?)`,
      [name, price, JSON.stringify(recipe)]
    );
    res.json({ id: result.lastID });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// ---------- API: SALES ----------
app.post('/api/sales', async (req, res) => {
  try {
    const { product_id, qty } = req.body;
    const product = await getAsync('SELECT * FROM products WHERE id = ?', [product_id]);
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const recipe = JSON.parse(product.recipe_json);

    // Check stock
    for (const item of recipe) {
      const ing = await getAsync('SELECT * FROM ingredients WHERE id = ?', [item.ingredientId]);
      if (!ing) return res.status(400).json({ error: `Ingredient ${item.ingredientId} missing` });
      const required = item.qty * qty;
      if (ing.current_stock < required) {
        return res.status(400).json({
          error: `Not enough stock for ingredient ${ing.name}`,
          ingredient: ing.name
        });
      }
    }

    // Deduct stock
    for (const item of recipe) {
      const ing = await getAsync('SELECT * FROM ingredients WHERE id = ?', [item.ingredientId]);
      const required = item.qty * qty;
      const newStock = ing.current_stock - required;

      await runAsync(
        'UPDATE ingredients SET current_stock = ? WHERE id = ?',
        [newStock, ing.id]
      );
      await runAsync(
        `INSERT INTO inventory_logs (date, ingredient_id, change, reason)
         VALUES (datetime('now'), ?, ?, ?)`,
        [ing.id, -required, `Sale of ${product.name}`]
      );
    }

    const totalPrice = product.price * qty;
    await runAsync(
      `INSERT INTO sales (date, product_id, qty, total_price)
       VALUES (datetime('now'), ?, ?, ?)`,
      [product_id, qty, totalPrice]
    );

    res.json({ success: true, totalPrice });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to record sale' });
  }
});

// ---------- API: DASHBOARD ----------
app.get('/api/dashboard/summary', async (req, res) => {
  try {
    const revenueRow = await getAsync('SELECT SUM(total_price) AS revenue FROM sales');
    const salesCountRow = await getAsync('SELECT COUNT(*) AS sales_count FROM sales');
    const tubsRow = await getAsync('SELECT SUM(qty) AS total_tubs FROM sales');
    const lowStock = await allAsync(
      'SELECT * FROM ingredients WHERE current_stock <= reorder_level'
    );

    res.json({
      revenue: revenueRow?.revenue || 0,
      sales_count: salesCountRow?.sales_count || 0,
      total_tubs: tubsRow?.total_tubs || 0,
      low_stock: lowStock
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load summary' });
  }
});

app.get('/api/dashboard/sales-by-day', async (req, res) => {
  try {
    const rows = await allAsync(`
      SELECT date(date) AS day, SUM(total_price) AS revenue, SUM(qty) AS tubs
      FROM sales
      WHERE date >= date('now', '-30 day')
      GROUP BY date(date)
      ORDER BY date(date)
    `);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load chart data' });
  }
});

// ---------- API: PDF REPORT ----------
app.get('/api/reports/monthly-pdf', async (req, res) => {
  try {
    const month = req.query.month; // optional "YYYY-MM"
    const filter = month ? `WHERE strftime('%Y-%m', date) = ?` : '';
    const params = month ? [month] : [];

    const summary = await getAsync(
      `SELECT SUM(total_price) AS revenue, SUM(qty) AS tubs
       FROM sales ${filter}`,
      params
    );
    const ingredients = await allAsync('SELECT * FROM ingredients');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="cloofy-monthly-report.pdf"'
    );

    const doc = new PDFDocument();
    doc.pipe(res);

    doc.fontSize(20).text('CLOOFY Monthly Report', { underline: true });
    doc.moveDown();

    doc.fontSize(12).text(`Month: ${month || 'All Time'}`);
    doc.text(
      `Total Revenue: LKR ${(summary?.revenue || 0).toFixed(2)}`
    );
    doc.text(`Total Tubs Sold: ${summary?.tubs || 0}`);
    doc.moveDown();

    doc.text('Low Stock Ingredients:', { underline: true });
    const lowStock = ingredients.filter(
      i => i.current_stock <= i.reorder_level
    );
    if (lowStock.length === 0) {
      doc.text('- None 🎉');
    } else {
      lowStock.forEach(i => {
        doc.text(
          `- ${i.name}: ${i.current_stock} ${i.unit} (reorder at ${i.reorder_level})`
        );
      });
    }

    doc.end();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

// ---------- FRONTEND (INLINE HTML + JS + CSS) ----------
const htmlPage = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>CLOOFY Dashboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    * { box-sizing: border-box; font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif; }
    body { margin: 0; background: #fff7fb; color: #333; }
    .topbar { background: linear-gradient(90deg, #ff9ad5, #fdd37a); padding: 12px 16px; color: #fff; }
    .topbar h1 { margin: 0; font-size: 1.4rem; }

    nav.tabs { display: flex; border-bottom: 1px solid #eee; overflow-x: auto; }
    nav.tabs button { flex: 1; padding: 10px; border: none; background: #fff; font-size: 0.9rem; cursor: pointer; }
    nav.tabs button.active { border-bottom: 3px solid #ff8ac5; font-weight: 600; background: #fff0fb; }

    main { padding: 12px; }
    .tab { display: none; }
    .tab.active { display: block; }

    .cards { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
    .card { flex: 1 1 120px; background: #fff; border-radius: 10px; padding: 10px; box-shadow: 0 2px 6px rgba(0,0,0,0.06); }
    .card h3 { margin: 0 0 4px; font-size: 0.9rem; }
    .card p { margin: 0; font-size: 1.1rem; font-weight: 600; }

    #salesChart { max-height: 260px; }

    label { display: block; margin: 8px 0; font-size: 0.9rem; }
    input, select, button { width: 100%; padding: 8px; margin-top: 4px; border-radius: 8px; border: 1px solid #ddd; font-size: 0.9rem; }

    button { background: #ff8ac5; color: white; font-weight: 600; border: none; }
    button:hover { opacity: 0.9; }

    .ingredient-row { display: flex; justify-content: space-between; gap: 8px; padding: 8px; margin-bottom: 6px; background: #fff; border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
    .ingredient-row div:first-child { flex: 2; }
    .ingredient-row div:last-child { flex: 1; display: flex; flex-direction: column; }
    .ingredient-row .adj-input { width: 100%; margin-bottom: 4px; }
    .ingredient-row .adj-btn { width: 100%; }

    .form-grid { display: grid; grid-template-columns: 1fr; gap: 6px; margin-top: 8px; }
    @media (min-width: 650px) {
      .form-grid { grid-template-columns: repeat(3, 1fr); }
    }

    .status { margin-top: 8px; font-size: 0.9rem; }
    .status.success { color: #188a42; }
    .status.error { color: #d93232; }

    .hint { font-size: 0.8rem; color: #666; }

    ul { padding-left: 18px; }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body>
  <header class="topbar">
    <h1>CLOOFY – Control Panel</h1>
  </header>

  <nav class="tabs">
    <button data-tab="dashboard" class="active">Dashboard</button>
    <button data-tab="sales">Record Sale</button>
    <button data-tab="inventory">Inventory</button>
    <button data-tab="reports">Reports</button>
  </nav>

  <main>
    <!-- DASHBOARD -->
    <section id="tab-dashboard" class="tab active">
      <div class="cards">
        <div class="card">
          <h3>Total Revenue</h3>
          <p id="dash-revenue">LKR 0</p>
        </div>
        <div class="card">
          <h3>Total Tubs Sold</h3>
          <p id="dash-tubs">0</p>
        </div>
        <div class="card">
          <h3>Sales Count</h3>
          <p id="dash-sales-count">0</p>
        </div>
      </div>

      <h3>Sales (Last 30 Days)</h3>
      <div style="height:260px;">
        <canvas id="salesChart"></canvas>
      </div>

      <h3>Low Stock Alerts</h3>
      <ul id="low-stock-list"></ul>
    </section>

    <!-- SALES -->
    <section id="tab-sales" class="tab">
      <h2>Record Sale</h2>
      <label>
        Product:
        <select id="sale-product"></select>
      </label>
      <label>
        Quantity:
        <input type="number" id="sale-qty" min="1" value="1" />
      </label>
      <button id="sale-submit">Save Sale</button>
      <p id="sale-status" class="status"></p>
    </section>

    <!-- INVENTORY -->
    <section id="tab-inventory" class="tab">
      <h2>Ingredients</h2>
      <div id="ingredients-list"></div>

      <h3>Add Ingredient</h3>
      <div class="form-grid">
        <input id="ing-name" placeholder="Name (e.g. New Syrup)" />
        <input id="ing-unit" placeholder="Unit (g / ml / unit)" />
        <input id="ing-stock" placeholder="Current Stock" type="number" />
        <input id="ing-reorder" placeholder="Reorder Level" type="number" />
        <input id="ing-cost" placeholder="Cost per Unit (LKR)" type="number" />
        <button id="ing-add">Add</button>
      </div>
    </section>

    <!-- REPORTS -->
    <section id="tab-reports" class="tab">
      <h2>Reports</h2>
      <label>
        Month (YYYY-MM, optional):
        <input id="report-month" placeholder="2025-01" />
      </label>
      <button id="report-download">Download Monthly PDF</button>
      <p class="hint">Leave month empty to download report for all time.</p>
    </section>
  </main>

  <script>
    // Tab switching
    const tabs = document.querySelectorAll('nav.tabs button');
    const sections = document.querySelectorAll('main .tab');

    tabs.forEach(btn => {
      btn.addEventListener('click', () => {
        tabs.forEach(b => b.classList.remove('active'));
        sections.forEach(s => s.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      });
    });

    let salesChart;

    async function loadDashboard() {
      const res = await fetch('/api/dashboard/summary');
      const data = await res.json();

      document.getElementById('dash-revenue').textContent =
        'LKR ' + Number(data.revenue || 0).toLocaleString();
      document.getElementById('dash-tubs').textContent = data.total_tubs || 0;
      document.getElementById('dash-sales-count').textContent = data.sales_count || 0;

      const lowList = document.getElementById('low-stock-list');
      lowList.innerHTML = '';
      if (!data.low_stock || data.low_stock.length === 0) {
        lowList.innerHTML = '<li>No low stock items 🎉</li>';
      } else {
        data.low_stock.forEach(ing => {
          const li = document.createElement('li');
          li.textContent =
            ing.name + ' – ' +
            ing.current_stock + ' ' + ing.unit +
            ' (reorder at ' + ing.reorder_level + ')';
          lowList.appendChild(li);
        });
      }

      const resChart = await fetch('/api/dashboard/sales-by-day');
      const daysData = await resChart.json();
      const labels = daysData.map(r => r.day);
      const revenue = daysData.map(r => r.revenue);

      const ctx = document.getElementById('salesChart').getContext('2d');
      if (salesChart) salesChart.destroy();
      salesChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'Revenue (LKR)',
            data: revenue
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false
        }
      });
    }

    async function loadIngredients() {
      const res = await fetch('/api/ingredients');
      const ingredients = await res.json();
      const container = document.getElementById('ingredients-list');
      container.innerHTML = '';

      ingredients.forEach(ing => {
        const div = document.createElement('div');
        div.className = 'ingredient-row';
        div.innerHTML = \`
          <div>
            <strong>\${ing.name}</strong><br/>
            Stock: \${ing.current_stock} \${ing.unit} (Reorder at \${ing.reorder_level})<br/>
            Cost per \${ing.unit}: LKR \${ing.unit_cost}
          </div>
          <div>
            <input type="number" step="any" placeholder="Adjust stock" class="adj-input" />
            <button class="adj-btn">Apply</button>
          </div>
        \`;
        const input = div.querySelector('.adj-input');
        const button = div.querySelector('.adj-btn');
        button.addEventListener('click', async () => {
          const change = Number(input.value);
          if (!change) return;
          await fetch('/api/ingredients/' + ing.id + '/adjust', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ change, reason: 'Manual adjust' })
          });
          await loadIngredients();
          await loadDashboard();
        });
        container.appendChild(div);
      });
    }

    document.getElementById('ing-add').addEventListener('click', async () => {
      const name = document.getElementById('ing-name').value;
      const unit = document.getElementById('ing-unit').value;
      const stock = Number(document.getElementById('ing-stock').value || 0);
      const reorder = Number(document.getElementById('ing-reorder').value || 0);
      const cost = Number(document.getElementById('ing-cost').value || 0);

      if (!name || !unit) {
        alert('Name and unit are required');
        return;
      }

      await fetch('/api/ingredients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          unit,
          current_stock: stock,
          reorder_level: reorder,
          unit_cost: cost
        })
      });

      document.getElementById('ing-name').value = '';
      document.getElementById('ing-unit').value = '';
      document.getElementById('ing-stock').value = '';
      document.getElementById('ing-reorder').value = '';
      document.getElementById('ing-cost').value = '';

      await loadIngredients();
      await loadDashboard();
    });

    async function loadProductsForSales() {
      const res = await fetch('/api/products');
      const products = await res.json();
      const select = document.getElementById('sale-product');
      select.innerHTML = '';
      products.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = \`\${p.name} (LKR \${p.price})\`;
        select.appendChild(opt);
      });
    }

    document.getElementById('sale-submit').addEventListener('click', async () => {
      const product_id = Number(document.getElementById('sale-product').value);
      const qty = Number(document.getElementById('sale-qty').value || 1);
      const status = document.getElementById('sale-status');
      status.textContent = '';
      status.className = 'status';

      if (!product_id || qty <= 0) {
        status.textContent = 'Select a product and valid quantity.';
        status.className = 'status error';
        return;
      }

      try {
        const res = await fetch('/api/sales', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ product_id, qty })
        });
        const data = await res.json();
        if (!res.ok) {
          status.textContent = 'Error: ' + (data.error || 'Failed');
          status.className = 'status error';
        } else {
          status.textContent = 'Sale recorded. Total: LKR ' + data.totalPrice;
          status.className = 'status success';
          await loadDashboard();
          await loadIngredients();
        }
      } catch (e) {
        console.error(e);
        status.textContent = 'Error recording sale.';
        status.className = 'status error';
      }
    });

    document.getElementById('report-download').addEventListener('click', () => {
      const month = document.getElementById('report-month').value.trim();
      const url = month
        ? '/api/reports/monthly-pdf?month=' + encodeURIComponent(month)
        : '/api/reports/monthly-pdf';
      window.open(url, '_blank');
    });

    (async function init() {
      await loadDashboard();
      await loadIngredients();
      await loadProductsForSales();
    })();
  </script>
</body>
</html>
`;

app.get('/', (req, res) => {
  res.send(htmlPage);
});

// ---------- START SERVER ----------
app.listen(PORT, () => {
  console.log(`CLOOFY system running at http://localhost:${PORT}`);
});
