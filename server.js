require('dotenv').config();
const express = require('express');
const connectDB = require('./api/config/db');
const cors = require('cors');
const bodyParser = require('body-parser');
const routes = require('./api/routes');
const path = require('path');
const errorHandler = require('./api/middlewares/errorHandler');

const app = express();
const port = process.env.PORT || 3001;

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
app.use(express.static(path.join(__dirname, 'dist')));

// ==================== API ROUTES ====================
app.use('/api', routes);

// ==================== HEALTH CHECK ====================
app.get('/health', (req, res) => {
  res.json({ status: 'OK', uptime: process.uptime() });
});

// ==================== SPA ROUTES ====================
app.get('/panel', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// IMPORTANT: Catch-all AFTER API
app.get('*', (req, res) => {
  if (req.originalUrl.startsWith('/api')) {
    return res.status(404).json({
      success: false,
      message: 'API route not found'
    });
  }

  // Always return index.html for Angular routes
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// ==================== ERROR HANDLER ====================
app.use(errorHandler);

// ==================== START SERVER ====================
const server = app.listen(port, () => {
  console.log(`🚀 Server running on http://localhost:${port}`);
  console.log(`📦 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 API Base: http://localhost:${port}/api`);
});

module.exports = app;
