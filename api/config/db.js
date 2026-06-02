const mongoose = require('mongoose');
const { syncAllIndexes } = require('../models');

const connectDB = async () => {
  try {

    const options = {
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000,
      family: 4
    };

    const conn = await mongoose.connect(
      process.env.MONGODB_URI,
      options
    );

    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
    console.log(`📊 Database: ${conn.connection.name}`);
    console.log(
      `🔌 Connection State: ${
        conn.connection.readyState === 1
          ? 'Connected'
          : 'Disconnected'
      }`
    );

    // ==================== SYNC ALL INDEXES ====================
    console.log('🔄 Starting index synchronization...');
    await syncAllIndexes();
    console.log('✅ Index synchronization completed');
    // =========================================================

    mongoose.connection.on('error', (err) => {
      console.error('❌ MongoDB connection error:', err);
    });

    mongoose.connection.on('disconnected', () => {
      console.warn('⚠️ MongoDB disconnected');
    });

    mongoose.connection.on('reconnected', () => {
      console.log('🔄 MongoDB reconnected');
    });

  } catch (error) {

    console.error(`❌ MongoDB Connection Error: ${error.message}`);
    console.error('Full error:', error);

    if (process.env.NODE_ENV !== 'production') {
      process.exit(1);
    }
  }
};

module.exports = connectDB;
