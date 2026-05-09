const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    // Cosmos DB compatible connection options
    const options = {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      retryWrites: false,              // CRITICAL for Cosmos DB
      maxIdleTimeMS: 120000,            // Keep connections alive
      serverSelectionTimeoutMS: 30000, // 30 second timeout
      socketTimeoutMS: 45000,           // 45 second socket timeout
      family: 4,                        // Use IPv4
      // Add these for Cosmos DB compatibility
      ssl: true,
      tlsAllowInvalidCertificates: false
    };

    const conn = await mongoose.connect(process.env.MONGODB_URI, options);
    
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
    console.log(`📊 Database: ${conn.connection.name}`);
    console.log(`🔌 Connection State: ${conn.connection.readyState === 1 ? 'Connected' : 'Disconnected'}`);
    
    // Handle connection events
    mongoose.connection.on('error', (err) => {
      console.error('❌ MongoDB connection error:', err);
    });

    mongoose.connection.on('disconnected', () => {
      console.warn('⚠️  MongoDB disconnected');
    });

    mongoose.connection.on('reconnected', () => {
      console.log('🔄 MongoDB reconnected');
    });

  } catch (error) {
    console.error(`❌ MongoDB Connection Error: ${error.message}`);
    console.error('Full error:', error);
    // Don't exit process in production, let Azure handle restarts
    if (process.env.NODE_ENV !== 'production') {
      process.exit(1);
    }
  }
};

module.exports = connectDB;