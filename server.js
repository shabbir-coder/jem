require('dotenv').config();
const express = require('express');
const connectDB = require('./api/config/db');
const cors = require('cors');
const bodyParser = require('body-parser');
const routes = require('./api/routes');
const path = require('path');
const errorHandler = require('./api/middlewares/errorHandler');

const app = express();
const port = process.env.PORT || 3000;

// ==================== DB ====================
connectDB();

// ==================== MIDDLEWARE ====================
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  credentials: true
}));

app.use(bodyParser.json());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==================== STATIC FILES ====================
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/jem/uploads', express.static(path.join(__dirname, 'uploads')));
// ==================== HEALTH CHECK ====================
app.get('/health', (req, res) => {
  res.json({ status: 'OK', uptime: process.uptime() });
});

// ==================== /jem ROUTES (Admin Node App) ====================

// API routes under /jem/api
app.use('/jem/api', routes);

// Serve admin panel static files from dist/admin (or wherever your admin build is)
app.use('/jem', express.static(path.join(__dirname, 'dist/admin')));

// Admin SPA catch-all — any /jem/* that isn't API returns admin index.html
app.get('/jem/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist/admin', 'index.html'));
});

// ==================== REACT FRONTEND (root) ====================

// Serve React app static files
app.use(express.static(path.join(__dirname, 'dist/frontend')));

// React SPA catch-all
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist/frontend', 'index.html'));
});

// ==================== ERROR HANDLER ====================
app.use(errorHandler);

// ==================== START SERVER ====================
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Server running on http://localhost:${port}`);
  console.log(`📦 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 API Base: http://localhost:${port}/jem/api`);
});

module.exports = app;