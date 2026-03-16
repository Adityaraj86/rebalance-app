const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Connect to SQLite Database
const db = new sqlite3.Database('./model_portfolio.db', (err) => {
    if (err) console.error("Error connecting to database:", err.message);
    else console.log("Connected to the SQLite database.");
});

// Helper function to wrap DB queries in Promises
const queryDB = (query, params = []) => {
    return new Promise((resolve, reject) => {
        db.all(query, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
};

// API: Get Portfolio and Model Plan Data for a Client (Hardcoded to Amit Sharma C001)
app.get('/api/portfolio/:clientId', async (req, res) => {
    try {
        const clientId = req.params.clientId;
        
        const holdings = await queryDB(`SELECT fund_id, fund_name, current_value FROM client_holdings WHERE client_id = ?`, [clientId]);
        const plan = await queryDB(`SELECT fund_id, fund_name, asset_class, allocation_pct FROM model_funds`);
        
        let totalValue = holdings.reduce((sum, item) => sum + item.current_value, 0);

        // Combine data to calculate drift
        let comparison = [];
        let allFundIds = new Set([...holdings.map(h => h.fund_id), ...plan.map(p => p.fund_id)]);

        allFundIds.forEach(id => {
            let holding = holdings.find(h => h.fund_id === id) || { current_value: 0, fund_name: plan.find(p => p.fund_id === id).fund_name };
            let model = plan.find(p => p.fund_id === id);

            let currentPct = (holding.current_value / totalValue) * 100;
            let targetPct = model ? model.allocation_pct : 0;
            let drift = targetPct - currentPct;
            let amount = (drift / 100) * totalValue;

            let action = "REVIEW";
            if (model) {
                action = amount > 0 ? "BUY" : (amount < 0 ? "SELL" : "REVIEW");
            }

            comparison.push({
                fund_id: id,
                fund_name: holding.fund_name,
                current_value: holding.current_value,
                current_pct: currentPct,
                target_pct: targetPct,
                is_model_fund: model ? 1 : 0,
                drift: model ? drift : null,
                action: action,
                amount: model ? Math.abs(amount) : holding.current_value
            });
        });

        res.json({ totalValue, holdings, plan, comparison });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Save Rebalancing Session
app.post('/api/rebalance', async (req, res) => {
    const { clientId, portfolioValue, totalBuy, totalSell, netCash, items } = req.body;
    
    db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        
        const insertSession = `INSERT INTO rebalance_sessions (client_id, created_at, portfolio_value, total_to_buy, total_to_sell, net_cash_needed, status) VALUES (?, datetime('now'), ?, ?, ?, ?, 'APPLIED')`;
        
        db.run(insertSession, [clientId, portfolioValue, totalBuy, totalSell, netCash], function(err) {
            if (err) return db.run('ROLLBACK', () => res.status(500).json({ error: err.message }));
            
            const sessionId = this.lastID;
            const insertItem = `INSERT INTO rebalance_items (session_id, fund_id, fund_name, action, amount, current_pct, target_pct, post_rebalance_pct, is_model_fund) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            
            const stmt = db.prepare(insertItem);
            items.forEach(item => {
                stmt.run([sessionId, item.fund_id, item.fund_name, item.action, item.amount, item.current_pct, item.target_pct, item.target_pct, item.is_model_fund]);
            });
            stmt.finalize();
            
            db.run('COMMIT', () => res.json({ success: true, sessionId }));
        });
    });
});

// API: Get History
app.get('/api/history', async (req, res) => {
    try {
        const history = await queryDB(`SELECT * FROM rebalance_sessions ORDER BY created_at DESC`);
        res.json(history);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Update Plan
app.post('/api/update-plan', async (req, res) => {
    const { updates } = req.body; 
    try {
        db.serialize(() => {
            db.run('BEGIN TRANSACTION');
            const stmt = db.prepare(`UPDATE model_funds SET allocation_pct = ? WHERE fund_id = ?`);
            updates.forEach(u => stmt.run([u.allocation_pct, u.fund_id]));
            stmt.finalize();
            db.run('COMMIT', () => res.json({ success: true }));
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));