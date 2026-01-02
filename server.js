import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cron from 'node-cron';
import { calculateWeeklyPenalties } from './jobs/penaltyCalculator.js';

// Load environment variables
dotenv.config();

// Import routes
import authRoutes from './routes/auth.js';
import goalsRoutes from './routes/goals.js';
import workoutsRoutes from './routes/workouts.js';
import paymentsRoutes from './routes/payments.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Root route - handle Supabase redirects that might go to root
app.get('/', (req, res) => {
  // Check if this is a Supabase auth callback (has hash fragment)
  // Since hash fragments aren't sent to server, we redirect to the callback handler
  // The client-side JavaScript will handle the hash
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>MyFitMinder - Auth Callback</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <script>
        // Extract hash and redirect to appropriate callback
        const hash = window.location.hash;
        if (hash.includes('type=recovery')) {
          window.location.href = '/api/auth/reset-password-callback' + hash;
        } else if (hash.includes('type=signup') || hash.includes('type=email')) {
          window.location.href = '/api/auth/verify-email-callback' + hash;
        } else {
          document.body.innerHTML = '<h1>MyFitMinder Backend</h1><p>If you were redirected here for password reset or email verification, please use the correct link from your email.</p>';
        }
      </script>
    </head>
    <body>
      <p>Redirecting...</p>
    </body>
    </html>
  `);
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/goals', goalsRoutes);
app.use('/api/workouts', workoutsRoutes);
app.use('/api/payments', paymentsRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

// 404 handler
app.use((req, res) => {
  console.log(`404 - Route not found: ${req.method} ${req.path}`);
  res.status(404).json({ 
    error: 'Route not found',
    path: req.path,
    method: req.method
  });
});

// Schedule weekly penalty calculation (every Sunday at 11:59 PM UTC)
// Format: minute hour day-of-month month day-of-week
// This calculates penalties for the week that just ended (Sunday to Saturday)
// Note: Ensure server timezone is set to UTC or use TZ=UTC environment variable
const penaltyCronExpression = '59 23 * * 0'; // 11:59 PM on Sunday

// Set timezone to UTC for cron scheduling (if not already set)
if (!process.env.TZ) {
  process.env.TZ = 'UTC';
}

cron.schedule(penaltyCronExpression, async () => {
  const now = new Date();
  console.log('Running scheduled penalty calculation...');
  console.log(`Current UTC time: ${now.toISOString()}`);
  console.log(`Current day of week: ${now.getUTCDay()} (0=Sunday)`);
  
  try {
    // Calculate for the previous week (the week that just ended)
    // At Sunday 11:59 PM UTC, we want to calculate for the week that ended on Saturday
    // So we use a date from the previous week (7 days ago)
    const previousWeekDate = new Date();
    previousWeekDate.setUTCDate(previousWeekDate.getUTCDate() - 7);
    console.log(`Calculating penalties for week ending on previous Saturday`);
    console.log(`Using reference date: ${previousWeekDate.toISOString()}`);
    
    await calculateWeeklyPenalties(previousWeekDate);
  } catch (error) {
    console.error('Scheduled penalty calculation failed:', error);
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 MyFitMinder Backend running on port ${PORT}`);
  console.log(`📅 Penalty calculation scheduled for Sundays at 11:59 PM UTC`);
  console.log(`   Calculates penalties for the week that just ended (Sunday to Saturday)`);
});

// Manual trigger endpoint for testing (remove in production or protect with admin auth)
if (process.env.NODE_ENV === 'development') {
  app.post('/api/admin/calculate-penalties', async (req, res) => {
    try {
      await calculateWeeklyPenalties();
      res.json({ message: 'Penalty calculation completed' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}

